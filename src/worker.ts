import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi";
import {
  AdminAuthorization,
  api,
  Authorization,
  FileTooLarge,
  MAX_UPLOAD_BYTES,
  Principal,
  type PrincipalShape,
} from "./api.ts";
import { ApiKeys, Files } from "./resources.ts";

const FILE_KEY_PATTERN = /^[0-9a-f]{16}\/[A-Za-z0-9._-]+$/;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  json: "application/json",
  html: "text/html; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  zip: "application/zip",
  gz: "application/gzip",
};

const contentTypeFor = (name: string) =>
  CONTENT_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ??
  "application/octet-stream";

const sanitizeName = (name: string) => {
  const base = name.split(/[/\\]/).pop() ?? "";
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 128);
  return safe.length > 0 ? safe : "file.bin";
};

const sha256Hex = (input: string) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input),
    );
    return Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  });

const randomHex = (bytes: number) =>
  Effect.sync(() =>
    Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  );

export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const files = yield* Cloudflare.R2.ReadWriteBucket(Files);
    const keys = yield* Cloudflare.KV.ReadWriteNamespace(ApiKeys);
    const adminToken = yield* Config.redacted("GHDROP_ADMIN_TOKEN");
    const selfUrl = yield* Cloudflare.Worker.URL;

    // Storage failures are infrastructure defects, not part of the API
    // contract — they surface as 500s rather than typed errors.
    const bucket = {
      get: (key: string) => files.get(key).pipe(Effect.orDie),
      put: (
        key: string,
        value: Uint8Array,
        options: {
          httpMetadata: { contentType: string };
          customMetadata: Record<string, string>;
        },
      ) => files.put(key, value, options).pipe(Effect.orDie),
      delete: (key: string) => files.delete(key).pipe(Effect.orDie),
    };
    const kv = {
      get: (key: string) => keys.get(key).pipe(Effect.orDie),
      put: (...args: Parameters<typeof keys.put>) =>
        keys.put(...args).pipe(Effect.orDie),
      delete: (key: string) => keys.delete(key).pipe(Effect.orDie),
      list: <M>(options: { prefix: string }) =>
        keys.list<M>(options).pipe(Effect.orDie),
    };

    const isAdminToken = Effect.fn(function* (token: string) {
      const provided = yield* sha256Hex(token);
      const expected = yield* sha256Hex(Redacted.value(adminToken));
      return provided === expected;
    });

    const ADMIN: PrincipalShape = {
      keyId: "admin",
      label: "admin token",
      admin: true,
    };

    const resolvePrincipalIn = Effect.fn(function* (
      credential: Redacted.Redacted,
    ) {
      const token = Redacted.value(credential).trim();
      if (token.length === 0) {
        return yield* new HttpApiError.Unauthorized();
      }
      if (yield* isAdminToken(token)) return ADMIN;
      const hash = yield* sha256Hex(token);
      const record = yield* kv.get(`key:${hash}`);
      if (record === null) {
        return yield* new HttpApiError.Unauthorized();
      }
      const meta = JSON.parse(record) as { keyId: string; label: string };
      return { keyId: meta.keyId, label: meta.label, admin: false };
    });

    /**
     * Resolve a bearer token into a principal, or fail 401.
     *
     * The KV lookup is `RuntimeContext`-coloured because Cloudflare bindings
     * only work inside a request. Middleware always runs inside one, but that
     * requirement would otherwise be demanded at router *build* time (init),
     * where no request exists — so it is discharged here.
     */
    const resolvePrincipal = (
      credential: Redacted.Redacted,
    ): Effect.Effect<PrincipalShape, HttpApiError.Unauthorized> =>
      resolvePrincipalIn(credential) as Effect.Effect<
        PrincipalShape,
        HttpApiError.Unauthorized
      >;

    const AuthorizationLive = Layer.succeed(Authorization, {
      bearer: (httpEffect, { credential }) =>
        resolvePrincipal(credential).pipe(
          Effect.flatMap((principal) =>
            Effect.provideService(httpEffect, Principal, principal),
          ),
        ),
    });

    const AdminAuthorizationLive = Layer.succeed(AdminAuthorization, {
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const principal = yield* resolvePrincipal(credential);
          if (!principal.admin) {
            return yield* new HttpApiError.Forbidden();
          }
          return yield* Effect.provideService(httpEffect, Principal, principal);
        }),
    });

    const FilesLive = HttpApiBuilder.group(api, "files", (handlers) =>
      handlers
        .handle(
          "upload",
          Effect.fn(function* ({ payload, query }) {
            if (payload.byteLength === 0) {
              return yield* new HttpApiError.BadRequest();
            }
            if (payload.byteLength > MAX_UPLOAD_BYTES) {
              return yield* new FileTooLarge({ maxBytes: MAX_UPLOAD_BYTES });
            }
            const principal = yield* Principal;
            const name = sanitizeName(query.name);
            const contentType = contentTypeFor(name);
            const key = `${yield* randomHex(8)}/${name}`;
            yield* bucket.put(key, payload, {
              httpMetadata: { contentType },
              customMetadata: { uploadedBy: principal.keyId },
            });
            const base = (yield* selfUrl).replace(/\/+$/, "");
            return {
              url: `${base}/f/${key}`,
              key,
              name,
              size: payload.byteLength,
              contentType,
            };
          }),
        )
        .handle(
          "download",
          Effect.fn(function* ({ params }) {
            const key = `${params.id}/${params.name}`;
            if (!FILE_KEY_PATTERN.test(key)) {
              return yield* new HttpApiError.NotFound();
            }
            const object = yield* bucket.get(key);
            if (object === null) {
              return yield* new HttpApiError.NotFound();
            }
            return HttpServerResponse.stream(object.body, {
              contentType:
                object.httpMetadata?.contentType ?? "application/octet-stream",
              headers: {
                "cache-control": "public, max-age=31536000, immutable",
                etag: object.httpEtag,
                "content-length": String(object.size),
              },
            });
          }),
        )
        .handle(
          "delete",
          Effect.fn(function* ({ params }) {
            const key = `${params.id}/${params.name}`;
            if (!FILE_KEY_PATTERN.test(key)) {
              return yield* new HttpApiError.NotFound();
            }
            if ((yield* bucket.get(key)) === null) {
              return yield* new HttpApiError.NotFound();
            }
            yield* bucket.delete(key);
            return { deleted: key };
          }),
        ),
    );

    const KeysLive = HttpApiBuilder.group(api, "keys", (handlers) =>
      handlers
        .handle(
          "create",
          Effect.fn(function* ({ payload }) {
            const label = payload.label.slice(0, 64) || "default";
            const apiKey = `gfd_${yield* randomHex(24)}`;
            const hash = yield* sha256Hex(apiKey);
            const keyId = hash.slice(0, 12);
            const createdAt = new Date().toISOString();
            const meta = { keyId, label, createdAt };
            yield* kv.put(`key:${hash}`, JSON.stringify(meta), {
              metadata: meta,
            });
            yield* kv.put(`keyid:${keyId}`, hash);
            return { apiKey, ...meta };
          }),
        )
        .handle(
          "list",
          Effect.fn(function* () {
            const listing = yield* kv.list<{
              keyId: string;
              label: string;
              createdAt: string;
            }>({ prefix: "key:" });
            return listing.keys.flatMap((k: { metadata?: unknown }) =>
              k.metadata == null
                ? []
                : [k.metadata as { keyId: string; label: string; createdAt: string }],
            );
          }),
        )
        .handle(
          "revoke",
          Effect.fn(function* ({ params }) {
            const hash = yield* kv.get(`keyid:${params.keyId}`);
            if (hash === null) {
              return yield* new HttpApiError.NotFound();
            }
            yield* kv.delete(`key:${hash}`);
            yield* kv.delete(`keyid:${params.keyId}`);
            return { revoked: params.keyId };
          }),
        ),
    );

    const MetaLive = HttpApiBuilder.group(api, "meta", (handlers) =>
      handlers.handle("index", () =>
        Effect.succeed(
          "gh-file-drop\n\n" +
            "  POST   /files?name=<filename>  upload (Authorization: Bearer <api key>)\n" +
            "  GET    /f/<id>/<name>          download (public)\n" +
            "  DELETE /f/<id>/<name>          delete (api key)\n" +
            "  POST   /keys                   mint api key (admin token)\n" +
            "  GET    /keys                   list api keys (admin token)\n" +
            "  DELETE /keys/<keyId>           revoke api key (admin token)\n" +
            "\nOpenAPI: /openapi.json\n",
        ),
      ),
    );

    // workerd has no filesystem; nothing in this API serves files by path.
    const FileSystemLive = FileSystem.layerNoop({});
    const PlatformLive = Layer.mergeAll(
      HttpRouter.layer,
      HttpPlatform.layer.pipe(Layer.provide(FileSystemLive)),
      FileSystemLive,
      Etag.layerWeak,
      Path.layer,
    );

    // The init closure is evaluated once per isolate and its scope is never
    // closed, so the router is built against a scope we deliberately keep open.
    const scope = yield* Scope.make();

    const fetch = yield* HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(api, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide([FilesLive, KeysLive, MetaLive]),
        Layer.provide([AuthorizationLive, AdminAuthorizationLive]),
      ),
    ).pipe(
      Effect.provide(PlatformLive),
      Effect.provideService(Scope.Scope, scope),
    );

    return { fetch };
  }).pipe(
    Effect.provide([
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.KV.ReadWriteNamespaceBinding,
    ]),
  ),
);
