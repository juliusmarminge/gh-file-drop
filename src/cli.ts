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
 *   flags (--url / --api-key)
 *   env   (GHDROP_URL / GHDROP_API_KEY)
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
import * as Stream from "effect/Stream";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import pkg from "../package.json" with { type: "json" };
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
  }),
  Command.withDescription("Upload files to a public URL for sharing in GitHub PRs"),
);

const resolveService = Effect.gen(function* () {
  const root = yield* ghdrop;
  const stored = yield* readStoredConfig;
  const url = Option.getOrUndefined(root.url) ?? process.env.GHDROP_URL ?? stored.url;
  if (url === undefined) {
    return yield* new CliError({
      message:
        "no service URL configured — pass --url, set GHDROP_URL, or run `ghdrop login <url>`",
    });
  }
  const token = Option.getOrUndefined(root.apiKey) ?? process.env.GHDROP_API_KEY ?? stored.apiKey;
  if (token === undefined) {
    return yield* new CliError({
      message:
        "no API key configured — pass --api-key, set GHDROP_API_KEY, or run `ghdrop login <url> --api-key <key>`",
    });
  }
  return { url: url.replace(/\/+$/, ""), token };
});

/** A client derived from the shared HttpApi, authenticated as `token`. */
const serviceClient = Effect.gen(function* () {
  const service = yield* resolveService;
  return yield* HttpApiClient.make(api, {
    baseUrl: service.url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(service.token)),
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
    default: {
      const message = (error as { message?: unknown }).message;
      return typeof message === "string" ? message : error._tag;
    }
  }
};

const asCliError = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.mapError(effect, (error) => new CliError({ message: explain(error as never) }));

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
    json: Flag.boolean("json").pipe(Flag.withDescription("Print results as JSON")),
  },
  Effect.fn(function* ({ files, json, markdown, name }) {
    if (Option.isSome(name) && files.length > 1) {
      return yield* new CliError({
        message: "--name only works with a single file",
      });
    }
    const client = yield* serviceClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const results = [];
    for (const file of files) {
      const payload = yield* fs
        .readFile(file)
        .pipe(
          Effect.mapError((e) => new CliError({ message: `cannot read ${file}: ${e.message}` })),
        );
      const uploadName = Option.getOrElse(name, () => path.basename(file));
      results.push(
        yield* asCliError(client.files.upload({ query: { name: uploadName }, payload })),
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
  Command.withDescription("Upload one or more files; prints one public URL per line"),
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
    const client = yield* serviceClient;
    const result = yield* asCliError(client.files.delete({ params: splitKey(target) }));
    yield* Console.log(`deleted ${result.deleted}`);
  }),
).pipe(Command.withDescription("Delete an uploaded file"));

// ── login ────────────────────────────────────────────────────────────────────

const login = Command.make(
  "login",
  {
    serviceUrl: Argument.string("url").pipe(
      Argument.withDescription("Service URL, e.g. https://gh-file-drop-api.<account>.workers.dev"),
    ),
  },
  Effect.fn(function* ({ serviceUrl }) {
    const root = yield* ghdrop;
    const merged = yield* writeStoredConfig({
      url: serviceUrl.replace(/\/+$/, ""),
      ...(Option.isSome(root.apiKey) ? { apiKey: root.apiKey.value } : {}),
    });
    yield* Console.log(`saved ${yield* configPath}`);
    if (merged.apiKey === undefined) {
      yield* Console.log(
        "no API key stored yet — pass --api-key, or ask whoever runs the service for one (`vpr keys create`)",
      );
    }
  }),
).pipe(Command.withDescription("Store the service URL and credentials in the config file"));

// ── update ───────────────────────────────────────────────────────────────────

/** Single source of truth for the version — no second place to bump. */
const VERSION = pkg.version;

const DEFAULT_REPO = "juliusmarminge/gh-file-drop";

/** The release asset matching the machine this binary is running on. */
const assetName = () => {
  if (process.platform === "win32") return "ghdrop-win-x64.exe";
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `ghdrop-${os}-${arch}`;
};

/** Run a command, capturing stdout; stderr is surfaced in the error. */
const run = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, [...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const decoder = new TextDecoder();
    let out = "";
    let err = "";
    const drain = (stream: Stream.Stream<Uint8Array, unknown>, onChunk: (text: string) => void) =>
      Stream.runForEach(stream, (chunk) =>
        Effect.sync(() => onChunk(decoder.decode(chunk, { stream: true }))),
      );
    yield* Effect.all(
      [drain(handle.stdout, (t) => (out += t)), drain(handle.stderr, (t) => (err += t))],
      { concurrency: "unbounded" },
    );
    return { code: Number(yield* handle.exitCode), out, err };
  }).pipe(
    Effect.scoped,
    Effect.mapError(() => new CliError({ message: `could not run \`${command}\`` })),
  );

const update = Command.make(
  "update",
  {
    method: Flag.choice("method", ["gh"]).pipe(
      Flag.withDefault("gh"),
      Flag.withDescription("How to fetch the release (gh: GitHub CLI)"),
    ),
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Reinstall even if already on the latest version"),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDefault(DEFAULT_REPO),
      Flag.withDescription("GitHub repository to fetch releases from"),
    ),
  },
  Effect.fn(function* ({ force, repo }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = process.execPath;

    // A SEA runs as itself; from source, execPath is `node`, and there would
    // be no binary to replace.
    if (/(^|\/|\\)node(\.exe)?$/.test(target)) {
      return yield* new CliError({
        message: "`update` only works on the standalone binary — this is running from source",
      });
    }

    const gh = yield* run("which", ["gh"]);
    if (gh.code !== 0) {
      return yield* new CliError({
        message:
          "`gh` is not installed — it is needed to download from a private repo (https://cli.github.com)",
      });
    }

    const latest = yield* run("gh", [
      "release",
      "view",
      "-R",
      repo,
      "--json",
      "tagName",
      "-q",
      ".tagName",
    ]);
    if (latest.code !== 0) {
      return yield* new CliError({
        message: `could not read the latest release: ${latest.err.trim() || "is `gh` authenticated?"}`,
      });
    }
    const tag = latest.out.trim();
    if (tag === `v${VERSION}` && !force) {
      return yield* Console.log(`already on the latest version (${tag})`);
    }

    // Stage the download beside the current binary so the swap is a rename
    // within one filesystem rather than a copy across devices.
    const staged = `${target}.new`;
    yield* Console.log(`downloading ${assetName()} ${tag}…`);
    const download = yield* run("gh", [
      "release",
      "download",
      tag,
      "-R",
      repo,
      "-p",
      assetName(),
      "-O",
      staged,
      "--clobber",
    ]);
    if (download.code !== 0) {
      yield* fs.remove(staged).pipe(Effect.catchCause(() => Effect.void));
      const detail = download.err.trim();
      return yield* new CliError({
        message: /permission denied/i.test(detail)
          ? `cannot write into ${path.dirname(target)} — re-run somewhere writable, or reinstall by hand`
          : `download failed: ${detail || `no ${assetName()} in ${tag}?`}`,
      });
    }

    yield* fs
      .chmod(staged, 0o755)
      .pipe(Effect.mapError(() => new CliError({ message: `cannot make ${staged} executable` })));

    // Never swap in something that cannot run.
    const check = yield* run(staged, ["--version"]);
    if (check.code !== 0) {
      yield* fs.remove(staged).pipe(Effect.catchCause(() => Effect.void));
      return yield* new CliError({
        message: "the downloaded binary failed to run — leaving the current one in place",
      });
    }

    // Windows refuses to replace a running executable, so move it aside first.
    const previous = `${target}.old`;
    if (process.platform === "win32") {
      yield* fs.rename(target, previous).pipe(Effect.catchCause(() => Effect.void));
    }
    yield* fs.rename(staged, target).pipe(
      Effect.mapError(
        () =>
          new CliError({
            message: `cannot replace ${target} — check permissions (a sudo-owned location needs sudo)`,
          }),
      ),
    );
    yield* fs.remove(previous).pipe(Effect.catchCause(() => Effect.void));

    yield* Console.log(`updated ${VERSION} → ${check.out.trim().replace(/^ghdrop v?/, "")}`);
  }),
).pipe(
  Command.withDescription("Replace this binary with the latest release"),
  Command.withExamples([{ command: "ghdrop update", description: "Update to the latest release" }]),
);

// ── run ──────────────────────────────────────────────────────────────────────

ghdrop.pipe(
  Command.withSubcommands([upload, del, login, update]),
  Command.run({ version: VERSION }),
  Effect.catchTag("CliError", (error) =>
    Console.error(`error: ${error.message}`).pipe(
      Effect.andThen(Effect.sync(() => process.exit(1))),
    ),
  ),
  Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain,
);
