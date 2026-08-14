#!/usr/bin/env node
/**
 * ghdrop — upload files to your gh-file-drop service and print public URLs
 * you can paste into GitHub PR comments.
 *
 * Every request goes through a client derived from the shared `HttpApi`
 * definition in `./api.ts`, so paths, payloads, and error types are checked
 * against the Worker's contract at compile time.
 *
 * This is the user-facing surface, and ships as a standalone binary. Deploying
 * the service is maintainer tooling and lives in `scripts/deploy.ts`.
 *
 * Config resolution (first match wins):
 *   flags (--url / --api-key / --admin-token)
 *   env   (GHDROP_URL / GHDROP_API_KEY / GHDROP_ADMIN_TOKEN)
 *   file  (~/.config/ghdrop/config.json — written by `ghdrop login`)
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { api, FileInfo } from "./api.ts";
import { configPath, readStoredConfig, writeStoredConfig } from "./config.ts";

class CliError extends Data.TaggedError("CliError")<{
  readonly message: string;
}> {}

// ── root command & config resolution ─────────────────────────────────────────

const ghdrop = Command.make("ghdrop").pipe(
  Command.withSharedFlags({
    url: Flag.string("url").pipe(
      Flag.optional,
      Flag.withDescription("Service URL (default: $GHDROP_URL, then config file)"),
    ),
    apiKey: Flag.string("api-key").pipe(
      Flag.optional,
      Flag.withDescription("API key (default: $GHDROP_API_KEY, then config file)"),
    ),
    adminToken: Flag.string("admin-token").pipe(
      Flag.optional,
      Flag.withDescription(
        "Admin token (default: $GHDROP_ADMIN_TOKEN, then config file)",
      ),
    ),
  }),
  Command.withDescription(
    "Upload files to a public URL for sharing in GitHub PRs",
  ),
);

const resolveService = Effect.fn(function* (needs: "apiKey" | "adminToken") {
  const root = yield* ghdrop;
  const stored = yield* readStoredConfig;
  const url =
    Option.getOrUndefined(root.url) ?? process.env.GHDROP_URL ?? stored.url;
  if (url === undefined) {
    return yield* new CliError({
      message:
        "no service URL configured — pass --url, set GHDROP_URL, or run `ghdrop login <url>`",
    });
  }
  const apiKey =
    Option.getOrUndefined(root.apiKey) ??
    process.env.GHDROP_API_KEY ??
    stored.apiKey;
  const adminToken =
    Option.getOrUndefined(root.adminToken) ??
    process.env.GHDROP_ADMIN_TOKEN ??
    stored.adminToken;
  const token = needs === "adminToken" ? adminToken : (apiKey ?? adminToken);
  if (token === undefined) {
    return yield* new CliError({
      message:
        needs === "adminToken"
          ? "no admin token configured — pass --admin-token or set GHDROP_ADMIN_TOKEN (the value the service was deployed with)"
          : "no API key configured — pass --api-key, set GHDROP_API_KEY, or run `ghdrop login <url> --api-key <key>`",
    });
  }
  return { url: url.replace(/\/+$/, ""), token };
});

/** A client derived from the shared HttpApi, authenticated as `token`. */
const clientFor = Effect.fn(function* (needs: "apiKey" | "adminToken") {
  const service = yield* resolveService(needs);
  return yield* HttpApiClient.make(api, {
    baseUrl: service.url,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(service.token),
    ),
  });
});

/** Turn the API's typed errors into one-line CLI messages. */
const explain = (error: { readonly _tag: string } & Record<string, unknown>) => {
  switch (error._tag) {
    case "Unauthorized":
      return "unauthorized — the API key is missing or invalid";
    case "Forbidden":
      return "forbidden — this action needs the admin token";
    case "NotFound":
      return "not found";
    case "BadRequest":
      return "the server rejected the request (empty file?)";
    case "FileTooLarge":
      return `file too large (max ${Math.round(Number(error.maxBytes) / 1024 / 1024)} MB)`;
    case "SchemaError":
      return "the server returned an unexpected response shape";
    default:
      return String((error as { message?: unknown }).message ?? error._tag);
  }
};

const asCliError = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.mapError(
    effect,
    (error) => new CliError({ message: explain(error as never) }),
  );

/** `--json` output, encoded through the same schema the server answers with. */
const encodeResults = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(FileInfo), { space: 2 }),
);

/** Split a file URL (or bare key) into its `<id>/<name>` parts. */
const splitKey = (target: string) => {
  const key = target.startsWith("http")
    ? new URL(target).pathname.replace(/^\/f\//, "")
    : target.replace(/^\/?(f\/)?/, "");
  const [id, ...rest] = key.split("/");
  return { id: id ?? "", name: rest.join("/") };
};

// ── upload ───────────────────────────────────────────────────────────────────

const upload = Command.make(
  "upload",
  {
    files: Argument.file("file", { mustExist: true }).pipe(
      Argument.variadic({ min: 1 }),
      Argument.withDescription("File(s) to upload"),
    ),
    name: Flag.string("name").pipe(
      Flag.withAlias("n"),
      Flag.optional,
      Flag.withDescription("Override the uploaded filename (single file only)"),
    ),
    markdown: Flag.boolean("markdown").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("Print Markdown ready to paste into a PR comment"),
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print results as JSON"),
    ),
  },
  Effect.fn(function* ({ files, json, markdown, name }) {
    if (Option.isSome(name) && files.length > 1) {
      return yield* new CliError({
        message: "--name only works with a single file",
      });
    }
    const client = yield* clientFor("apiKey");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const results = [];
    for (const file of files) {
      const payload = yield* fs
        .readFile(file)
        .pipe(
          Effect.mapError(
            (e) => new CliError({ message: `cannot read ${file}: ${e.message}` }),
          ),
        );
      const uploadName = Option.getOrElse(name, () => path.basename(file));
      results.push(
        yield* asCliError(
          client.files.upload({ query: { name: uploadName }, payload }),
        ),
      );
    }
    if (json) {
      return yield* Console.log(yield* encodeResults(results));
    }
    for (const result of results) {
      if (markdown) {
        yield* Console.log(
          result.contentType.startsWith("image/")
            ? `![${result.name}](${result.url})`
            : `[${result.name}](${result.url})`,
        );
      } else {
        yield* Console.log(result.url);
      }
    }
  }),
).pipe(
  Command.withDescription(
    "Upload one or more files; prints one public URL per line",
  ),
  Command.withAlias("up"),
  Command.withExamples([
    {
      command: "ghdrop upload screenshot.png",
      description: "Upload a file and print its public URL",
    },
    {
      command: "ghdrop upload -m before.png after.png",
      description: "Upload two images and print Markdown for a PR comment",
    },
  ]),
);

// ── delete ───────────────────────────────────────────────────────────────────

const del = Command.make(
  "delete",
  {
    target: Argument.string("url").pipe(
      Argument.withDescription("File URL (or <id>/<name> key) returned by upload"),
    ),
  },
  Effect.fn(function* ({ target }) {
    const client = yield* clientFor("apiKey");
    const result = yield* asCliError(
      client.files.delete({ params: splitKey(target) }),
    );
    yield* Console.log(`deleted ${result.deleted}`);
  }),
).pipe(Command.withDescription("Delete an uploaded file"));

// ── login ────────────────────────────────────────────────────────────────────

const login = Command.make(
  "login",
  {
    serviceUrl: Argument.string("url").pipe(
      Argument.withDescription(
        "Service URL, e.g. https://gh-file-drop-api.<account>.workers.dev",
      ),
    ),
  },
  Effect.fn(function* ({ serviceUrl }) {
    const root = yield* ghdrop;
    const merged = yield* writeStoredConfig({
      url: serviceUrl.replace(/\/+$/, ""),
      ...(Option.isSome(root.apiKey) ? { apiKey: root.apiKey.value } : {}),
      ...(Option.isSome(root.adminToken)
        ? { adminToken: root.adminToken.value }
        : {}),
    });
    yield* Console.log(`saved ${yield* configPath}`);
    if (merged.apiKey === undefined && merged.adminToken === undefined) {
      yield* Console.log(
        "no credentials stored yet — run `ghdrop keys create --save` (needs the admin token) or `ghdrop login <url> --api-key <key>`",
      );
    }
  }),
).pipe(
  Command.withDescription(
    "Store the service URL and credentials in the config file",
  ),
);

// ── keys (admin) ─────────────────────────────────────────────────────────────

const keysCreate = Command.make(
  "create",
  {
    label: Flag.string("label").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Human-readable label for the key"),
    ),
    save: Flag.boolean("save").pipe(
      Flag.withDescription("Also store the new key as this machine's API key"),
    ),
  },
  Effect.fn(function* ({ label, save }) {
    const client = yield* clientFor("adminToken");
    const created = yield* asCliError(client.keys.create({ payload: { label } }));
    if (save) {
      yield* writeStoredConfig({ apiKey: created.apiKey });
      yield* Console.log(`saved API key to ${yield* configPath}`);
    }
    yield* Console.log(`apiKey: ${created.apiKey}`);
    yield* Console.log(`keyId:  ${created.keyId}`);
  }),
).pipe(Command.withDescription("Mint a new API key (shown once — save it)"));

const keysList = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    const client = yield* clientFor("adminToken");
    const keys = yield* asCliError(client.keys.list({}));
    if (keys.length === 0) {
      return yield* Console.log("no API keys");
    }
    for (const key of keys) {
      yield* Console.log(`${key.keyId}  ${key.createdAt}  ${key.label}`);
    }
  }),
).pipe(Command.withDescription("List API keys"));

const keysRevoke = Command.make(
  "revoke",
  {
    keyId: Argument.string("key-id").pipe(
      Argument.withDescription("Key id (from `ghdrop keys list`)"),
    ),
  },
  Effect.fn(function* ({ keyId }) {
    const client = yield* clientFor("adminToken");
    const result = yield* asCliError(client.keys.revoke({ params: { keyId } }));
    yield* Console.log(`revoked ${result.revoked}`);
  }),
).pipe(Command.withDescription("Revoke an API key"));

const keys = Command.make("keys").pipe(
  Command.withSubcommands([keysCreate, keysList, keysRevoke]),
  Command.withDescription("Manage API keys (requires the admin token)"),
);

// ── run ──────────────────────────────────────────────────────────────────────

ghdrop.pipe(
  Command.withSubcommands([upload, del, login, keys]),
  Command.run({ version: "0.1.1" }),
  Effect.catchTag("CliError", (error) =>
    Console.error(`error: ${error.message}`).pipe(
      Effect.andThen(Effect.sync(() => process.exit(1))),
    ),
  ),
  Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain,
);
