/**
 * The per-machine config file, shared by the CLI and the deploy task.
 *
 * Written by `ghdrop login` / `vpr deploy`, read by every command as the
 * lowest-priority source (flags win, then env, then this).
 */

import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Only ever holds user-facing credentials. The admin token stays in alchemy
 * state and is never written here.
 */
export const StoredConfig = Schema.Struct({
  url: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
});
export type StoredConfig = typeof StoredConfig.Type;

const StoredConfigJson = Schema.fromJsonString(StoredConfig, { space: 2 });
const decodeConfig = Schema.decodeEffect(StoredConfigJson);
const encodeConfig = Schema.encodeEffect(StoredConfigJson);

/** `$XDG_CONFIG_HOME/ghdrop/config.json`, falling back to `~/.config`. */
export const configPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const base = process.env.XDG_CONFIG_HOME ?? path.join(NodeOS.homedir(), ".config");
  return path.join(base, "ghdrop", "config.json");
});

/** Missing, unreadable, or malformed config is simply "nothing configured". */
export const readStoredConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(yield* configPath);
  return yield* decodeConfig(text);
}).pipe(Effect.catchCause(() => Effect.succeed<StoredConfig>({})));

export const writeStoredConfig = Effect.fn(function* (update: StoredConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* configPath;
  const merged = { ...(yield* readStoredConfig), ...update };
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${yield* encodeConfig(merged)}\n`);
  return merged;
});
