---
name: ghdrop
description: Upload a local file and get a public URL, so it can be embedded in GitHub PRs, issues, and comments. Use whenever you need to share a screenshot, image, diagram, video, log, profile, or build artifact on GitHub — the GitHub API cannot upload attachments, so a URL from ghdrop is the only way to embed one from the terminal.
metadata:
  short-description: Share local files in GitHub PRs via a public URL
---

# ghdrop — share local files on GitHub

The GitHub API has no attachment upload. To put an image or file in a PR body,
issue, or comment, it must already be at a public URL. `ghdrop` uploads a local
file to Cloudflare R2 and prints that URL.

## Use when

- Embedding a screenshot, before/after image, or recording in a PR or issue.
- Attaching a log, profile, coverage report, or build artifact to a comment.
- Any "share this file with a human on GitHub" task.

Do **not** use for files that belong in the repo (commit those instead), or for
anything secret — **every uploaded file is world-readable at an
unguessable-but-public URL**. Never upload credentials, `.env` files, private
keys, or customer data.

## Usage

```sh
ghdrop upload screenshot.png
# → https://<service>/f/93372b348bf1d98e/screenshot.png
```

One URL per line on stdout, in argument order — safe to capture in a variable.

| Command | Result |
| --- | --- |
| `ghdrop upload <file>` | Upload, print the public URL |
| `ghdrop upload <a> <b> ...` | Upload several, one URL per line |
| `ghdrop upload -m <files...>` | Print Markdown: `![name](url)` for images, `[name](url)` otherwise |
| `ghdrop upload --json <files...>` | `[{"url","key","name","size","contentType"}]` — use when parsing |
| `ghdrop upload -n <name> <file>` | Override the stored filename (single file) |
| `ghdrop delete <url>` | Remove a previously uploaded file |

Add `--url` / `--api-key` only if the ambient config is not being used.

## One-shot: put a screenshot in a PR comment

```sh
URL=$(ghdrop upload ./out/screenshot.png)
gh pr comment 123 --body "Fixed the overflow:

![screenshot]($URL)"
```

Appending to the PR body instead of commenting:

```sh
URL=$(ghdrop upload ./demo.mp4)
gh pr edit 123 --body "$(gh pr view 123 --json body -q .body)

## Demo

$URL"
```

For several images at once, `-m` already emits paste-ready Markdown:

```sh
BODY=$(ghdrop upload -m before.png after.png)
gh issue comment 45 --body "$BODY"
```

## Notes

- Images (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`) get an image content-type, so
  GitHub renders them inline. Videos (`.mp4`, `.mov`, `.webm`) render in a
  player. Everything else downloads as a file.
- URLs are immutable and cached forever — re-upload for a new version rather
  than expecting an existing URL to change.
- Max 100 MB per file.
- Uploads are not automatically cleaned up; `ghdrop delete <url>` to remove one.

## If it fails

- `command not found: ghdrop` — the CLI isn't on PATH. Run it directly with
  `node <repo>/src/cli.ts upload <file>` if the repo is available, and tell the
  user they can link it with `vp link -- --global` (pnpm's global bin directory
  must be on their PATH — `pnpm setup` arranges that) or drop a standalone
  `ghdrop` binary on their PATH.
- `error: no service URL configured` / `no API key configured` — this machine
  has not been set up. **Stop and tell the user**; setup is a one-time,
  credential-creating step documented in the gh-file-drop README (`vpr deploy`,
  or `ghdrop login <url> --api-key <key>` on an already-deployed service). Do
  not attempt to deploy or mint keys on your own — the binary cannot anyway.
- `HTTP 403: invalid API key` — the key was revoked; the user must mint a new
  one from a checkout of the repo (`vpr keys create --save`).
- `ghdrop --help` and `ghdrop upload --help` list the current flags.
