/**
 * Read deployed values back out of alchemy state.
 *
 * The admin token is an `Alchemy.Random` resource, so the stack itself is the
 * only place it exists — no `.env`, and nothing to keep in the user's config.
 * Maintainer scripts pull it from here on demand.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export class StackError extends Data.TaggedError("StackError")<{
  readonly message: string;
}> {}

export const STACK_NAME = "gh-file-drop";

/** Alchemy's default stage, matching `dev_${USER}`. */
export const defaultStage = () => `dev_${process.env.USER ?? "unknown"}`;

/** `Redacted` values are serialized into state behind a marker key. */
const RedactedString = Schema.Union([
  Schema.String,
  Schema.Struct({ __redacted__: Schema.String }),
]);

const decodeState = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.decodeEffect(
    Schema.fromJsonString(Schema.Struct({ attr: Schema.Struct(fields) })),
  );

const decodeWorkerState = decodeState({ url: Schema.String });
const decodeTokenState = decodeState({ text: RedactedString });

/** Run `alchemy state get` for one resource and return its JSON. */
const stateGet = (fqn: string, stage: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "pnpm",
        [
          "alchemy",
          "state",
          "get",
          "--stack",
          STACK_NAME,
          "--stage",
          stage,
          "--fqn",
          fqn,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      ),
    );
    const decoder = new TextDecoder();
    let output = "";
    yield* Stream.runForEach(handle.stdout, (chunk) =>
      Effect.sync(() => {
        output += decoder.decode(chunk, { stream: true });
      }),
    );
    if (Number(yield* handle.exitCode) !== 0) {
      return yield* new StackError({
        message: `could not read ${fqn} from stage ${stage} — has it been deployed?`,
      });
    }
    // pnpm may prefix its own noise; the state document starts at the brace.
    const start = output.indexOf("{");
    if (start === -1) {
      return yield* new StackError({
        message: `no state found for ${fqn} in stage ${stage}`,
      });
    }
    return output.slice(start);
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new StackError({ message: `failed to read stack state: ${error}` }),
      ),
    ),
  );

/** The deployed service URL and its admin token, straight from the stack. */
export const readDeployment = Effect.fn(function* (stage?: string) {
  const target = stage ?? defaultStage();
  const worker = yield* decodeWorkerState(yield* stateGet("Api", target)).pipe(
    Effect.mapError(
      () => new StackError({ message: "unexpected shape for the Api state" }),
    ),
  );
  const token = yield* decodeTokenState(
    yield* stateGet("AdminToken", target),
  ).pipe(
    Effect.mapError(
      () =>
        new StackError({ message: "unexpected shape for the AdminToken state" }),
    ),
  );
  return {
    url: worker.attr.url.replace(/\/+$/, ""),
    adminToken:
      typeof token.attr.text === "string"
        ? token.attr.text
        : token.attr.text.__redacted__,
  };
});
