# gh-file-drop

Upload files to a public URL so you can share them in GitHub PR descriptions and comments
(the GitHub API doesn't support attachments).

- **Service**: Cloudflare Worker + R2 (file storage) + KV (API keys), defined
  with [Alchemy](https://alchemy.run) and Effect. Files are served through the
  Worker itself — no public bucket config needed.
- **CLI**: `ghdrop`, built on Effect v4's `effect/unstable/cli`.
- **Tooling**: [Vite+](https://github.com/voidzero-dev/vite-plus) (`vp install`,
  `vp add`, …) for package management.

## Deploy

Deploying is maintainer tooling, so it's a task in this repo rather than a
subcommand of the CLI — the `ghdrop` binary stays purely user-facing.

```sh
vp install
vpr deploy         # = node scripts/deploy.ts
```

The task handles everything:

1. Finds the admin token (`$GHDROP_ADMIN_TOKEN` → `.env` → config file) — or
   generates one and writes it to `.env` (gitignored; alchemy auto-loads it on
   every future deploy).
2. Runs `alchemy deploy --yes` (prompts for Cloudflare OAuth/API token on the
   very first run; stored in `~/.alchemy/profiles.json`).
3. Prompts to save the service URL + admin token to
   `~/.config/ghdrop/config.json`.
4. Prompts to mint an API key for this machine and saves it.
5. Prompts to link `ghdrop` onto your PATH (`vp link -- --global`, or
   `pnpm link --global` without Vite+). If pnpm's global bin directory isn't on
   your PATH yet, it offers `pnpm setup` and otherwise prints the `export` line
   to add — you need a new shell before `ghdrop` resolves.

`vpr deploy --stage prod` targets another stage, and `--yes` (or any non-TTY
run) accepts the defaults. `pnpm alchemy dev` runs the whole stack locally
(workerd + local R2/KV emulation) on `http://localhost:1337`; `pnpm alchemy
destroy` tears everything down.

For other machines / CI, either copy credentials via
`ghdrop login <url> --api-key <key>`, or skip the config file entirely with env
vars: `GHDROP_URL`, `GHDROP_API_KEY`, `GHDROP_ADMIN_TOKEN` (flags win over env,
env wins over the config file).

To get `ghdrop` on your PATH from a checkout: `vp link -- --global` (the `bin`
entry points at `src/cli.ts`, which Node runs natively). Elsewhere, use a
[standalone binary](#standalone-binary).

## Usage

```sh
ghdrop upload screenshot.png             # prints the public URL
ghdrop upload -m before.png after.png    # Markdown, ready to paste into a PR
ghdrop upload --json report.html         # machine-readable output
ghdrop upload -n renamed.txt notes.txt   # override the stored filename
ghdrop delete <url>                      # remove an upload

ghdrop keys create --label ci --save     # mint a key (admin)
ghdrop keys list                         # keyId / created / label (admin)
ghdrop keys revoke <keyId>               # revoke (admin)

ghdrop deploy                            # (re)deploy + config/key prompts
```

## Standalone binary

`vp pack` builds the CLI into a single executable (Node's SEA), so `ghdrop` can
go to a machine with no Node, no clone, and no package manager.

```sh
pnpm build                       # this platform      → build/ghdrop
pnpm build:all                   # every target       → build/ghdrop-<os>-<arch>
GHDROP_TARGETS=linux-x64 pnpm build
```

Targets are `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win-x64`;
cross-compiling downloads and caches the matching Node runtime. Build settings
live in `vite.config.ts` — note that passing `--exe` on the command line would
*override* that config, so the scripts deliberately don't.

Each binary is ~145 MB (~42 MB gzipped) because it embeds Node. The binary
contains only the user-facing commands — deploying stays in `vpr deploy`, which
needs this repo.

The bundle is deliberately just Node + Effect. Nothing from Alchemy, Cloudflare,
or the Worker reaches it: `src/cli.ts` depends only on `src/api.ts` (the shared
contract, which imports nothing but `effect`) and `src/config.ts`. Verify with:

```sh
grep -c -i "alchemy\|cloudflare\|workerd" dist/cli.mjs   # → 0
```

The HTTP client is `FetchHttpClient` (Node's built-in fetch) rather than the
undici-backed one, which keeps ~110 bundled modules out of the binary — the
bundle is 1.13 MB, of which everything is `effect` plus the `@effect/platform-node`
services the CLI actually uses (filesystem, path, terminal).

### Distributing it

Ship the binaries as GitHub release assets:

```sh
pnpm build:all
gh release create v0.1.0 build/ghdrop-* --title "ghdrop v0.1.0"
```

Users then install with one line:

```sh
curl -fsSL https://github.com/<owner>/gh-file-drop/releases/latest/download/ghdrop-darwin-arm64 \
  -o /usr/local/bin/ghdrop && chmod +x /usr/local/bin/ghdrop
```

and point it at the service once:

```sh
ghdrop login https://<your-worker-url> --api-key <key>
```

## Agent skill

`skills/ghdrop/SKILL.md` teaches coding agents to use this service one-shot
(upload → paste into a PR with `gh`). It's usage-only — setup stays here in the
README, and the skill tells agents to stop and ask rather than deploy anything.

The same `SKILL.md` format works in both Claude Code and Codex; install it
globally by symlinking the canonical copy into the shared skills dir, then into
each harness:

```sh
ln -s "$PWD/skills/ghdrop" ~/.agents/skills/ghdrop
ln -s ../../.agents/skills/ghdrop ~/.claude/skills/ghdrop
ln -s ../../.agents/skills/ghdrop ~/.codex/skills/ghdrop
```

Agents need the CLI on PATH — either `vp link -- --global` (which `ghdrop
deploy` offers) or a standalone binary dropped somewhere on PATH — and a
configured machine.

## API

`src/api.ts` is an `HttpApi` definition — the single source of truth. The Worker
implements it with `HttpApiBuilder`; the CLI derives its client from the same
value with `HttpApiClient`, so a contract change is a compile error on both
sides. The service serves its own OpenAPI document at `/openapi.json`.

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /files?name=<filename>` | API key | Upload raw body, returns `{url, key, name, size, contentType}` |
| `GET /f/<id>/<name>` | public | Download (immutable cache, correct content-type) |
| `DELETE /f/<id>/<name>` | API key | Delete an upload |
| `POST /keys` | admin token | Mint an API key, returns `{apiKey, keyId, ...}` |
| `GET /keys` | admin token | List keys |
| `DELETE /keys/<keyId>` | admin token | Revoke a key |

Auth is two `HttpApiMiddleware` security schemes over `Authorization: Bearer
<token>`: `Authorization` accepts any valid key, `AdminAuthorization` accepts
only the admin token, and both resolve the token into a `Principal` that
handlers read from context (uploads record it as `uploadedBy`). API keys are
stored in KV as SHA-256 hashes; the admin token is a Worker secret and also
works wherever an API key does. Max upload size is 100 MB (`413` past that).

## Layout

```
alchemy.run.ts     # Alchemy stack (Cloudflare providers + state)
vite.config.ts     # vp pack config — single-executable build
src/api.ts         # HttpApi contract: endpoints, schemas, auth middleware
src/resources.ts   # R2 bucket + KV namespace definitions
src/worker.ts      # Worker implementing the HttpApi (handlers, auth, bindings)
src/cli.ts         # ghdrop CLI — user-facing only (derived HttpApiClient)
src/config.ts      # ~/.config/ghdrop/config.json, shared by CLI and deploy
scripts/deploy.ts  # `vpr deploy` — deploy the stack and set up this machine
skills/ghdrop/     # agent skill (usage docs for Claude Code / Codex)
```
