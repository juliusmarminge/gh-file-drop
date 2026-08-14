# gh-file-drop

Upload a file, get a public URL, paste it into a GitHub PR — the GitHub API has
no attachment upload, so a URL is the only way to embed a screenshot or a log
from the terminal.

- **Service** — Cloudflare Worker + R2 (files) + KV (API keys), defined with
  [Alchemy](https://alchemy.run) and Effect. The Worker serves the files itself,
  with their real content type, so images render inline on GitHub.
- **CLI** — `ghdrop`, built on Effect's `unstable/cli` and shipped as a single
  executable.
- **Contract** — one `HttpApi` definition (`src/api.ts`) that the Worker
  implements and the CLI derives its client from.

## Install

Grab a binary from [releases](https://github.com/juliusmarminge/gh-file-drop/releases).
The repo is private, so fetch it with `gh` rather than `curl`:

```sh
gh release download v0.1.2 -R juliusmarminge/gh-file-drop -p ghdrop-darwin-arm64 \
  -O /usr/local/bin/ghdrop && chmod +x /usr/local/bin/ghdrop

ghdrop login https://<your-worker-url> --api-key <key>
```

Assets: `ghdrop-{darwin,linux}-{arm64,x64}` and `ghdrop-win-x64.exe`.

## Usage

```sh
ghdrop upload screenshot.png             # prints the public URL
ghdrop upload -m before.png after.png    # Markdown, ready to paste into a PR
ghdrop upload --json report.html         # machine-readable output
ghdrop upload -n renamed.txt notes.txt   # override the stored filename
ghdrop delete <url>
```

Settings resolve from flags, then `GHDROP_URL` / `GHDROP_API_KEY`, then
`~/.config/ghdrop/config.json` (written by `ghdrop login`). Max upload is
100 MB, and **every uploaded file is public to anyone with the URL**.

`skills/ghdrop/SKILL.md` teaches coding agents the same workflow — it works in
both Claude Code and Codex, and carries its own install instructions.

## Running your own

```sh
vp install
vpr deploy          # deploy the stack, then set this machine up
```

`vpr deploy` runs `alchemy deploy`, saves the service URL, mints an API key for
this machine, and offers to put `ghdrop` on your PATH. The admin token is an
`Alchemy.Random` resource — generated once, kept in alchemy state, bound to the
Worker as a secret — so there is no `.env`, and it never reaches a user's
config.

That's also why minting keys is maintainer tooling rather than a CLI command:

```sh
vpr keys create --label ci [--save]
vpr keys list
vpr keys revoke <keyId>
```

Both are subcommands of one `ghdrop-admin` CLI: see `vpr admin --help`, plus
`--stage <name>` to target another stage.

## Development

```sh
pnpm dev            # local workerd + R2/KV emulation on :1337
pnpm check          # format, lint, type-check
pnpm build          # single executable → build/ghdrop
pnpm build:all      # every target → build/ghdrop-<os>-<arch>
pnpm destroy
```

`vp install` also wires a pre-commit hook (through the `prepare` script) that
runs `vp check --fix` over staged files.

> `pnpm dev` deliberately uses its own `local` alchemy stage. Sharing a stage
> with a deployment makes the next deploy plan read `replace (local → live)`,
> which recreates the KV namespace and R2 bucket — wiping API keys and uploaded
> files. When in doubt, `pnpm alchemy deploy --dry-run` and read the plan.

To cut a release: bump the version, `pnpm build:all`, then
`gh release create vX.Y.Z build/ghdrop-*`.

## API

The service serves its own OpenAPI document at `/openapi.json`. Auth is
`Authorization: Bearer <token>` through two `HttpApiMiddleware` security schemes
that resolve a token into a `Principal`. API keys are stored in KV as SHA-256
hashes; the admin token works wherever an API key does.

| Route                         | Auth        | Purpose                                       |
| ----------------------------- | ----------- | --------------------------------------------- |
| `POST /files?name=<filename>` | API key     | Upload raw body, returns the file's URL       |
| `GET /f/<id>/<name>`          | public      | Download (immutable cache, real content type) |
| `DELETE /f/<id>/<name>`       | API key     | Delete an upload                              |
| `POST /keys`                  | admin token | Mint an API key                               |
| `GET /keys`                   | admin token | List keys                                     |
| `DELETE /keys/<keyId>`        | admin token | Revoke a key                                  |

## Layout

```
alchemy.run.ts     # Alchemy stack
vite.config.ts     # single-executable build, fmt/lint, staged hooks
src/api.ts         # HttpApi contract: endpoints, schemas, auth middleware
src/resources.ts   # R2 bucket, KV namespace, admin token
src/worker.ts      # Worker implementing the contract
src/cli.ts         # ghdrop — the user-facing CLI
src/config.ts      # ~/.config/ghdrop/config.json (url + apiKey)
scripts/admin.ts   # ghdrop-admin — deploy + key management
skills/ghdrop/     # agent skill
```
