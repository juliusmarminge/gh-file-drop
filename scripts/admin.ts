#!/usr/bin/env node
/**
 * ghdrop-admin — maintainer tooling for the gh-file-drop service.
 *
 *   vpr admin deploy [--stage prod] [--yes]
 *   vpr admin keys create [--label ci] [--save]
 *   vpr admin keys list
 *   vpr admin keys revoke <keyId>
 *
 * `vpr deploy` and `vpr keys …` are shortcuts for the same commands.
 *
 * This lives outside the `ghdrop` binary, which is purely user-facing. It needs
 * the repo: the Alchemy stack is the source of truth for the deployment, and
 * the admin token is an `Alchemy.Random` resource read straight back out of
 * stack state — never a `.env` file, never the user's config.
 */

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { Stage } from "alchemy/Stage";
import * as State from "alchemy/State";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as Prompt from "effect/unstable/cli/Prompt";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import Stack from "../alchemy.run.ts";
import pkg from "../package.json" with { type: "json" };
import { api } from "../src/api.ts";
import { configPath, readStoredConfig, writeStoredConfig } from "../src/config.ts";

class AdminError extends Data.TaggedError("AdminError")<{
  readonly message: string;
}> {}

const STACK_NAME = "gh-file-drop";

// ── processes ────────────────────────────────────────────────────────────────

/** Run a command, echoing its output to this terminal while capturing it. */
const runCapture = (
  command: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly env?: Record<string, string | undefined>;
    readonly quiet?: boolean;
  },
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, [...args], {
        // stdin stays attached so `alchemy` can prompt on first authentication.
        stdin: options?.quiet === true ? "ignore" : "inherit",
        stdout: "pipe",
        stderr: options?.quiet === true ? "ignore" : "pipe",
        env: options?.env,
      }),
    );

    const decoder = new TextDecoder();
    let output = "";
    const pump = (stream: Stream.Stream<Uint8Array, unknown>, to?: NodeJS.WriteStream) =>
      Stream.runForEach(stream, (chunk) =>
        Effect.sync(() => {
          output += decoder.decode(chunk, { stream: true });
          to?.write(chunk);
        }),
      );

    yield* Effect.all(
      options?.quiet === true
        ? [pump(handle.stdout)]
        : [pump(handle.stdout, process.stdout), pump(handle.stderr, process.stderr)],
      { concurrency: "unbounded" },
    );
    return { code: Number(yield* handle.exitCode), output };
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (error) =>
        new AdminError({
          message: `failed to run ${command}: ${String(error)}`,
        }),
    ),
  );

const commandExists = (bin: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner.exitCode(
      ChildProcess.make("which", [bin], { stdout: "ignore", stderr: "ignore" }),
    );
    return Number(code) === 0;
  }).pipe(Effect.orElseSucceed(() => false));

// ── reading the stack ────────────────────────────────────────────────────────

/**
 * This is one shared deployment, not a per-developer copy, so maintainer
 * commands target `prod` unless told otherwise — alchemy's own default
 * (`dev_$USER`) would give every machine its own service. Local work goes to
 * the `local` stage via `pnpm dev`.
 */
const DEFAULT_STAGE = "prod";

/**
 * Read resource attributes straight out of alchemy state, in process.
 *
 * This is the same path `alchemy state get` takes, minus the subprocess: build
 * the stack to get its configured state store, then query by fqn. It leans on
 * a few of alchemy's internals (`AuthProviders`, `Stage`, `AlchemyContextLive`)
 * to assemble the same service graph the CLI does.
 */
const readState = (stage: string, fqn: string) =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const persisted = yield* Effect.gen(function* () {
      const state = yield* yield* State.State;
      return yield* state.get({ stack: STACK_NAME, stage, fqn });
    }).pipe(Effect.provide(stack.services));

    // `PersistedState` also covers actions and in-flight creates, which carry
    // no attributes yet.
    if (persisted === undefined || !("attr" in persisted) || persisted.attr === undefined) {
      return yield* new AdminError({
        message: `no ${fqn} in stage ${stage} — has it been deployed?`,
      });
    }
    const attr: Record<string, unknown> = persisted.attr;
    return attr;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        // State operations address (stack, stage) explicitly, so the ambient
        // stage is only needed to build the layer.
        Layer.succeed(Stage, "placeholder"),
        AlchemyContextLive,
      ),
    ),
    Effect.scoped,
    Effect.catchTag("StateStoreError", (error) =>
      Effect.fail(
        new AdminError({
          message: `could not read stack state: ${String(error)}`,
        }),
      ),
    ),
  );

/** The deployed service URL and its admin token, straight from the stack. */
const readDeployment = Effect.fn(function* (stage: Option.Option<string>) {
  const target = Option.getOrElse(stage, () => DEFAULT_STAGE);
  const url = (yield* readState(target, "Api"))["url"];
  const secret = (yield* readState(target, "AdminToken"))["text"];
  // `Random` stores its value redacted, so unwrap rather than stringify.
  const adminToken = Redacted.isRedacted(secret) ? Redacted.value(secret) : secret;
  if (typeof url !== "string" || typeof adminToken !== "string") {
    return yield* new AdminError({
      message: "unexpected shape for the stack state",
    });
  }
  return { url: url.replace(/\/+$/, ""), adminToken };
});

// ── root command ─────────────────────────────────────────────────────────────

const admin = Command.make("ghdrop-admin").pipe(
  Command.withSharedFlags({
    stage: Flag.string("stage").pipe(
      Flag.optional,
      Flag.withDescription("Alchemy stage (default: dev_$USER)"),
    ),
  }),
  Command.withDescription("Maintainer tooling for the gh-file-drop service"),
);

/** A client authenticated with the stack's admin token. */
const adminClient = Effect.fn(function* (stage: Option.Option<string>) {
  const deployment = yield* readDeployment(stage);
  const client = yield* HttpApiClient.make(api, {
    baseUrl: deployment.url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(deployment.adminToken)),
  });
  return { client, url: deployment.url };
});

const mintKey = Effect.fn(function* (stage: Option.Option<string>, label: string, save: boolean) {
  const { client, url } = yield* adminClient(stage);
  const created = yield* client.keys
    .create({ payload: { label } })
    .pipe(
      Effect.mapError(
        (error) => new AdminError({ message: `could not mint an API key: ${error._tag}` }),
      ),
    );
  if (save) {
    yield* writeStoredConfig({ url, apiKey: created.apiKey });
  }
  return created;
});

// ── deploy ───────────────────────────────────────────────────────────────────

const confirmOr = Effect.fn(function* (
  interactive: boolean,
  fallback: boolean,
  message: string,
  initial: boolean,
) {
  if (!interactive) return fallback;
  return yield* Prompt.run(Prompt.confirm({ message, initial })).pipe(
    Effect.mapError(() => new AdminError({ message: "aborted" })),
  );
});

/** Where pnpm puts globally linked binaries. */
const globalBinDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return (
    process.env.PNPM_HOME ??
    (process.platform === "darwin"
      ? path.join(NodeOS.homedir(), "Library", "pnpm")
      : path.join(NodeOS.homedir(), ".local", "share", "pnpm"))
  );
});

/** `Path` models file separators, not the PATH variable's own delimiter. */
const pathDelimiter = process.platform === "win32" ? ";" : ":";

const onPath = (dir: string) => (process.env.PATH ?? "").split(pathDelimiter).includes(dir);

/**
 * Put `ghdrop` on PATH from this checkout — the difference between the service
 * being deployed and it being usable. Returns whether `ghdrop` runs by name.
 */
const linkGlobally = Effect.fn(function* (interactive: boolean) {
  if (yield* commandExists("ghdrop")) return true;

  // `vp link` forwards flags to the underlying package manager after `--`.
  const argv = (yield* commandExists("vp"))
    ? (["vp", "link", "--", "--global"] as const)
    : (["pnpm", "link", "--global"] as const);
  const [command, ...args] = argv;
  const hint = argv.join(" ");

  const link = yield* confirmOr(
    interactive,
    false,
    `Link \`ghdrop\` globally so you can run it from anywhere (${hint})?`,
    true,
  );
  if (!link) {
    yield* Console.log(`\nto run \`ghdrop\` from anywhere later: ${hint}`);
    return false;
  }

  // pnpm refuses to link unless its global bin directory exists and is on
  // PATH, so give the child process both — `pnpm setup` is then only needed
  // to make the directory permanent, not to make this link work.
  const dir = yield* globalBinDir;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catchCause(() => Effect.void));

  const { code } = yield* runCapture(command, args, {
    env: {
      ...process.env,
      PNPM_HOME: dir,
      PATH: `${dir}${pathDelimiter}${process.env.PATH ?? ""}`,
    },
  });
  if (code !== 0) {
    yield* Console.log(`\n\`${hint}\` failed — run it manually to use \`ghdrop\``);
    return false;
  }

  if (onPath(dir)) return yield* commandExists("ghdrop");

  yield* Console.log(`\nlinked into ${dir}, which is not on your PATH yet.`);
  const setup = yield* confirmOr(
    interactive,
    false,
    "Run `pnpm setup` to add it to your shell profile?",
    true,
  );
  if (setup) {
    const { code: setupCode } = yield* runCapture("pnpm", ["setup"], {
      env: { ...process.env, PNPM_HOME: dir },
    });
    if (setupCode === 0) {
      yield* Console.log("\nopen a new shell, then: ghdrop upload <file>");
      return false;
    }
  }
  yield* Console.log(`\nadd it yourself with:\n  export PATH="${dir}:$PATH"`);
  return false;
});

const deploy = Command.make(
  "deploy",
  {
    yes: Flag.boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Skip prompts and accept the defaults"),
    ),
  },
  Effect.fn(function* ({ yes }) {
    const { stage } = yield* admin;
    const interactive = process.stdin.isTTY === true && !yes;

    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists("alchemy.run.ts").pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new AdminError({
        message: "run this from the root of the gh-file-drop repo",
      });
    }

    const args = [
      "alchemy",
      "deploy",
      "--yes",
      "--stage",
      Option.getOrElse(stage, () => DEFAULT_STAGE),
    ];
    const { code, output } = yield* runCapture("pnpm", args);
    if (code !== 0) {
      return yield* new AdminError({
        message: `alchemy deploy exited with code ${code}`,
      });
    }

    const urlMatch =
      output.match(/url:\s*'(https?:\/\/[^']+)'/) ??
      output.match(/(https:\/\/[\w.-]+\.workers\.dev\S*)/);
    if (urlMatch === null) {
      return yield* new AdminError({
        message:
          "deploy succeeded but no service URL found in the output — run `ghdrop login <url>` manually",
      });
    }
    const url = urlMatch[1]!.replace(/\/+$/, "");

    const save = yield* confirmOr(interactive, true, `Save ${url} to ${yield* configPath}?`, true);
    if (save) {
      yield* writeStoredConfig({ url });
      yield* Console.log(`saved ${yield* configPath}`);
    }

    const stored = yield* readStoredConfig;
    const mint = yield* confirmOr(
      interactive,
      stored.apiKey === undefined,
      stored.apiKey === undefined
        ? "Mint an API key for this machine and save it?"
        : "An API key is already configured — mint a new one anyway?",
      stored.apiKey === undefined,
    );
    if (mint) {
      const created = yield* mintKey(stage, NodeOS.hostname(), save);
      if (save) {
        yield* Console.log(`minted API key ${created.keyId} and saved it`);
      } else {
        yield* Console.log(`apiKey: ${created.apiKey}`);
        yield* Console.log(`keyId:  ${created.keyId}`);
      }
    }

    const linked = yield* linkGlobally(interactive);
    yield* Console.log(
      linked
        ? "\nready — try: ghdrop upload <file>"
        : "\nready — try: node src/cli.ts upload <file>",
    );
  }),
).pipe(Command.withDescription("Deploy the stack and set this machine up to talk to it"));

// ── keys ─────────────────────────────────────────────────────────────────────

const keysCreate = Command.make(
  "create",
  {
    label: Flag.string("label").pipe(
      Flag.optional,
      Flag.withDescription("Human-readable label (default: this hostname)"),
    ),
    save: Flag.boolean("save").pipe(
      Flag.withDescription("Also store the new key as this machine's API key"),
    ),
  },
  Effect.fn(function* ({ label, save }) {
    const { stage } = yield* admin;
    const created = yield* mintKey(
      stage,
      Option.getOrElse(label, () => NodeOS.hostname()),
      save,
    );
    if (save) {
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
    const { stage } = yield* admin;
    const { client } = yield* adminClient(stage);
    const keys = yield* client.keys
      .list({})
      .pipe(
        Effect.mapError(
          (error) => new AdminError({ message: `could not list keys: ${error._tag}` }),
        ),
      );
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
    keyId: Argument.string("key-id").pipe(Argument.withDescription("Key id (from `keys list`)")),
  },
  Effect.fn(function* ({ keyId }) {
    const { stage } = yield* admin;
    const { client } = yield* adminClient(stage);
    const result = yield* client.keys
      .revoke({ params: { keyId } })
      .pipe(
        Effect.mapError(
          (error) => new AdminError({ message: `could not revoke ${keyId}: ${error._tag}` }),
        ),
      );
    yield* Console.log(`revoked ${result.revoked}`);
  }),
).pipe(Command.withDescription("Revoke an API key"));

const keys = Command.make("keys").pipe(
  Command.withSubcommands([keysCreate, keysList, keysRevoke]),
  Command.withDescription("Manage API keys (admin token read from the stack)"),
);

// ── run ──────────────────────────────────────────────────────────────────────

admin.pipe(
  Command.withSubcommands([deploy, keys]),
  Command.run({ version: pkg.version }),
  Effect.catchTag("AdminError", (error) =>
    Console.error(`error: ${error.message}`).pipe(
      Effect.andThen(Effect.sync(() => process.exit(1))),
    ),
  ),
  Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain,
);
