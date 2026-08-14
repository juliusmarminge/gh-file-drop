/**
 * The per-machine config file, shared by the CLI and the deploy task.
 *
 * Written by `ghdrop login` / `vpr deploy`, read by every command as the
 * lowest-priority source (flags win, then env, then this).
 */
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Os from "node:os";
import * as Path from "node:path";

export interface StoredConfig {
  url?: string;
  apiKey?: string;
  adminToken?: string;
}

export const configPath = Path.join(
  process.env.XDG_CONFIG_HOME ?? Path.join(Os.homedir(), ".config"),
  "ghdrop",
  "config.json",
);

export const readStoredConfig = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const text = yield* fs.readFileString(configPath);
  return JSON.parse(text) as StoredConfig;
}).pipe(Effect.catchCause(() => Effect.succeed<StoredConfig>({})));

export const writeStoredConfig = Effect.fn(function* (update: StoredConfig) {
  const fs = yield* FileSystem;
  const current = yield* readStoredConfig;
  const merged = { ...current, ...update };
  yield* fs.makeDirectory(Path.dirname(configPath), { recursive: true });
  yield* fs.writeFileString(configPath, JSON.stringify(merged, null, 2) + "\n");
  return merged;
});
