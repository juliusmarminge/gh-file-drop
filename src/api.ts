/**
 * The gh-file-drop HTTP API contract.
 *
 * This module is the single source of truth shared by the Worker (which
 * implements it with `HttpApiBuilder`) and the CLI (which derives a fully typed
 * client from it with `HttpApiClient`). Auth is expressed as `HttpApiMiddleware`
 * security schemes that resolve a bearer token into a `Principal`.
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/unstable/httpapi";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// ── principal ────────────────────────────────────────────────────────────────

/** Who is making the request, resolved by the auth middleware. */
export interface PrincipalShape {
  /** Short id of the API key, or "admin" for the root token. */
  readonly keyId: string;
  readonly label: string;
  readonly admin: boolean;
}

export class Principal extends Context.Service<Principal, PrincipalShape>()(
  "ghdrop/Principal",
) {}

/** Any valid API key (or the admin token). */
export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: Principal }
>()("ghdrop/Authorization", {
  security: { bearer: HttpApiSecurity.bearer },
  error: HttpApiError.Unauthorized,
}) {}

/** The admin token only — used to mint and revoke API keys. */
export class AdminAuthorization extends HttpApiMiddleware.Service<
  AdminAuthorization,
  { provides: Principal }
>()("ghdrop/AdminAuthorization", {
  security: { bearer: HttpApiSecurity.bearer },
  error: [HttpApiError.Unauthorized, HttpApiError.Forbidden],
}) {}

// ── schemas ──────────────────────────────────────────────────────────────────

export const FileInfo = Schema.Struct({
  /** Public URL — paste this into a GitHub PR. */
  url: Schema.String,
  /** Storage key, `<id>/<name>`. */
  key: Schema.String,
  name: Schema.String,
  size: Schema.Number,
  contentType: Schema.String,
});
export type FileInfo = typeof FileInfo.Type;

export const ApiKeyInfo = Schema.Struct({
  keyId: Schema.String,
  label: Schema.String,
  createdAt: Schema.String,
});
export type ApiKeyInfo = typeof ApiKeyInfo.Type;

export const NewApiKey = Schema.Struct({
  /** Shown once, at creation time. Only its hash is stored. */
  apiKey: Schema.String,
  keyId: Schema.String,
  label: Schema.String,
  createdAt: Schema.String,
});
export type NewApiKey = typeof NewApiKey.Type;

export class FileTooLarge extends Schema.TaggedError<FileTooLarge>()(
  "FileTooLarge",
  { maxBytes: Schema.Number },
) {}

/** 413 rather than the default error status. */
const FileTooLargeError = FileTooLarge.pipe(HttpApiSchema.status(413));

// ── endpoints ────────────────────────────────────────────────────────────────

const upload = HttpApiEndpoint.post("upload", "/files", {
  query: { name: Schema.String },
  payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
  success: FileInfo,
  error: [HttpApiError.BadRequest, FileTooLargeError],
}).middleware(Authorization);

const download = HttpApiEndpoint.get("download", "/f/:id/:name", {
  params: { id: Schema.String, name: Schema.String },
  // The handler returns the object's real content type, so browsers and GitHub
  // render images and video inline.
  success: HttpApiSchema.StreamUint8Array(),
  error: HttpApiError.NotFound,
});

const remove = HttpApiEndpoint.delete("delete", "/f/:id/:name", {
  params: { id: Schema.String, name: Schema.String },
  success: Schema.Struct({ deleted: Schema.String }),
  error: HttpApiError.NotFound,
}).middleware(Authorization);

const createKey = HttpApiEndpoint.post("create", "/keys", {
  payload: Schema.Struct({ label: Schema.String }),
  success: NewApiKey,
});

const listKeys = HttpApiEndpoint.get("list", "/keys", {
  success: Schema.Array(ApiKeyInfo),
});

const revokeKey = HttpApiEndpoint.delete("revoke", "/keys/:keyId", {
  params: { keyId: Schema.String },
  success: Schema.Struct({ revoked: Schema.String }),
  error: HttpApiError.NotFound,
});

const index = HttpApiEndpoint.get("index", "/", {
  success: Schema.String.pipe(HttpApiSchema.asText()),
});

// ── groups & api ─────────────────────────────────────────────────────────────

export const FilesGroup = HttpApiGroup.make("files").add(
  upload,
  download,
  remove,
);

export const KeysGroup = HttpApiGroup.make("keys")
  .add(createKey, listKeys, revokeKey)
  .middleware(AdminAuthorization);

export const MetaGroup = HttpApiGroup.make("meta").add(index);

export const api = HttpApi.make("ghdrop").add(FilesGroup, KeysGroup, MetaGroup);
