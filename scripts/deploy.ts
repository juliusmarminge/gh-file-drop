/**
 * Deploy the service and set this machine up to talk to it.
 *
 *   vpr deploy                 # or: vpr deploy --stage prod
 *   vpr deploy --yes           # accept every prompt
 *
 * This is maintainer tooling and lives outside the `ghdrop` binary, which is
 * purely user-facing. It needs the repo: the Alchemy stack is the source of
 * truth for the deployment.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import { Prompt } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpApiClient } from "effect/unstable/httpapi";
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Os from "node:os";
import * as Path from "node:path";
import { api } from "../src/api.ts";
import {
  configPath,
  readStoredConfig,
  writeStoredConfig,
} from "../src/config.ts";

class DeployError extends Data.TaggedError("DeployError")<{
  readonly message: string;
}> {}

const argv = process.argv.slice(2);
const stageFlag = argv.indexOf("--stage");
const stage = stageFlag === -1 ? undefined : argv[stageFlag + 1];
const yes = argv.includes("--yes") || argv.includes("-y");
const interactive = process.stdin.isTTY === true && !yes;

const confirmOr = Effect.fn(function* (
  fallback: boolean,
  message: string,
  initial: boolean,
) {
  if (!interactive) return fallback;
  return yield* Prompt.run(Prompt.confirm({ message, initial })).pipe(
    Effect.mapError(() => new DeployError({ message: "aborted" })),
  );
});

/** Run a command, echoing its output while capturing it. */
const runCapture = (
  command: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
) =>
  Effect.callback<{ code: number; output: string }, DeployError>((resume) => {
    const child = ChildProcess.spawn(command, [...args], {
      stdio: ["inherit", "pipe", "pipe"],
      env: env ?? process.env,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", (error) =>
      resume(
        Effect.fail(
          new DeployError({
            message: `failed to run ${command}: ${error.message}`,
          }),
        ),
      ),
    );
    child.on("close", (code) =>
      resume(Effect.succeed({ code: code ?? 1, output })),
    );
  });

const commandExists = (bin: string) =>
  Effect.sync(
    () => ChildProcess.spawnSync("which", [bin], { stdio: "ignore" }).status === 0,
  );

/**
 * Find the admin token (env → .env → config file), or generate one and
 * persist it to .env so `alchemy deploy` picks it up on every future run.
 */
const ensureAdminToken = Effect.gen(function* () {
  const fromEnv = process.env.GHDROP_ADMIN_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  const fs = yield* FileSystem;
  const envText = yield* fs
    .readFileString(".env")
    .pipe(Effect.catchCause(() => Effect.succeed("")));
  const fromDotenv = envText.match(/^GHDROP_ADMIN_TOKEN=(.+)$/m);
  if (fromDotenv !== null) return fromDotenv[1]!.trim();

  const stored = yield* readStoredConfig;
  if (stored.adminToken !== undefined) return stored.adminToken;

  const generate = yield* confirmOr(
    true,
    "No admin token found — generate one and save it to .env?",
    true,
  );
  if (!generate) {
    return yield* new DeployError({
      message:
        "deploy needs an admin token — set GHDROP_ADMIN_TOKEN or add it to .env",
    });
  }
  const token = Crypto.randomBytes(32).toString("hex");
  const updated =
    envText.length === 0 || envText.endsWith("\n") ? envText : `${envText}\n`;
  yield* fs.writeFileString(".env", `${updated}GHDROP_ADMIN_TOKEN=${token}\n`);
  yield* Console.log("generated admin token and saved it to .env");
  return token;
});

/** Where pnpm puts globally linked binaries. */
const globalBinDir = () =>
  process.env.PNPM_HOME ??
  (process.platform === "darwin"
    ? Path.join(Os.homedir(), "Library", "pnpm")
    : Path.join(Os.homedir(), ".local", "share", "pnpm"));

const onPath = (dir: string) =>
  (process.env.PATH ?? "").split(Path.delimiter).includes(dir);

/**
 * Put `ghdrop` on PATH from this checkout — the difference between the service
 * being deployed and it being usable. Returns whether `ghdrop` runs by name.
 */
const linkGlobally = Effect.gen(function* () {
  if (yield* commandExists("ghdrop")) return true;

  // `vp link` forwards flags to the underlying package manager after `--`.
  const argv = (yield* commandExists("vp"))
    ? (["vp", "link", "--", "--global"] as const)
    : (["pnpm", "link", "--global"] as const);
  const [command, ...args] = argv;
  const hint = argv.join(" ");

  const link = yield* confirmOr(
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
  const dir = globalBinDir();
  const fs = yield* FileSystem;
  yield* fs
    .makeDirectory(dir, { recursive: true })
    .pipe(Effect.catchCause(() => Effect.void));

  const { code } = yield* runCapture(command, args, {
    ...process.env,
    PNPM_HOME: dir,
    PATH: `${dir}${Path.delimiter}${process.env.PATH ?? ""}`,
  });
  if (code !== 0) {
    yield* Console.log(`\n\`${hint}\` failed — run it manually to use \`ghdrop\``);
    return false;
  }

  if (onPath(dir)) return yield* commandExists("ghdrop");

  yield* Console.log(`\nlinked into ${dir}, which is not on your PATH yet.`);
  const setup = yield* confirmOr(
    false,
    "Run `pnpm setup` to add it to your shell profile?",
    true,
  );
  if (setup) {
    const { code: setupCode } = yield* runCapture("pnpm", ["setup"], {
      ...process.env,
      PNPM_HOME: dir,
    });
    if (setupCode === 0) {
      yield* Console.log("\nopen a new shell, then: ghdrop upload <file>");
      return false;
    }
  }
  yield* Console.log(`\nadd it yourself with:\n  export PATH="${dir}:$PATH"`);
  return false;
});

const deploy = Effect.gen(function* () {
  const fs = yield* FileSystem;
  if (
    !(yield* fs.exists("alchemy.run.ts").pipe(Effect.orElseSucceed(() => false)))
  ) {
    return yield* new DeployError({
      message: "run this from the root of the gh-file-drop repo",
    });
  }

  const adminToken = yield* ensureAdminToken;

  const args = ["alchemy", "deploy", "--yes"];
  if (stage !== undefined) args.push("--stage", stage);
  const { code, output } = yield* runCapture("pnpm", args, {
    ...process.env,
    GHDROP_ADMIN_TOKEN: adminToken,
  });
  if (code !== 0) {
    return yield* new DeployError({
      message: `alchemy deploy exited with code ${code}`,
    });
  }

  const urlMatch =
    output.match(/url:\s*'(https?:\/\/[^']+)'/) ??
    output.match(/(https:\/\/[\w.-]+\.workers\.dev\S*)/);
  if (urlMatch === null) {
    return yield* new DeployError({
      message:
        "deploy succeeded but no service URL found in the output — run `ghdrop login <url>` manually",
    });
  }
  const url = urlMatch[1]!.replace(/\/+$/, "");

  const save = yield* confirmOr(
    true,
    `Save ${url} (and the admin token) to ${configPath}?`,
    true,
  );
  if (save) {
    yield* writeStoredConfig({ url, adminToken });
    yield* Console.log(`saved ${configPath}`);
  }

  const stored = yield* readStoredConfig;
  const mint = yield* confirmOr(
    stored.apiKey === undefined,
    stored.apiKey === undefined
      ? "Mint an API key for this machine and save it?"
      : "An API key is already configured — mint a new one anyway?",
    stored.apiKey === undefined,
  );
  if (mint) {
    const client = yield* HttpApiClient.make(api, {
      baseUrl: url,
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.bearerToken(adminToken),
      ),
    });
    const created = yield* client.keys
      .create({ payload: { label: Os.hostname() } })
      .pipe(
        Effect.mapError(
          (error) =>
            new DeployError({ message: `could not mint an API key: ${error._tag}` }),
        ),
      );
    if (save) {
      yield* writeStoredConfig({ apiKey: created.apiKey });
      yield* Console.log(`minted API key ${created.keyId} and saved it`);
    } else {
      yield* Console.log(`apiKey: ${created.apiKey}`);
      yield* Console.log(`keyId:  ${created.keyId}`);
    }
  }

  const linked = yield* linkGlobally;
  yield* Console.log(
    linked
      ? "\nready — try: ghdrop upload <file>"
      : "\nready — try: node src/cli.ts upload <file>",
  );
});

deploy.pipe(
  Effect.catchTag("DeployError", (error) =>
    Console.error(`error: ${error.message}`).pipe(
      Effect.andThen(Effect.sync(() => process.exit(1))),
    ),
  ),
  Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain,
);
