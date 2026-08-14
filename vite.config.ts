import { defineConfig } from "vite-plus";

/**
 * `vp pack` bundles the CLI into a standalone binary via Node's Single
 * Executable Applications, so `ghdrop` can be distributed as one file — no
 * Node install, no clone, no package manager.
 *
 * Building needs Node >= 25.7.0; `devEngines.runtime` in package.json pins it,
 * so `vp` fetches the right runtime automatically.
 *
 *   pnpm build                      # this platform        → build/ghdrop
 *   pnpm build:all                  # every target below   → build/ghdrop-<os>-<arch>
 *   GHDROP_TARGETS=linux-x64 pnpm build
 *
 * Note: pass no `--exe` flag — it would override this config with `exe: true`
 * and lose these settings.
 */
const ALL_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win-x64"] as const;

/** The Node runtime embedded in each binary. */
const NODE_VERSION = "26.7.0";

const requested = process.env.GHDROP_TARGETS;
const targets =
  requested === undefined
    ? undefined
    : (requested === "all" ? [...ALL_TARGETS] : requested.split(",")).map((name) => {
        const [platform, arch] = name.trim().split("-");
        return {
          platform: platform as "darwin" | "linux" | "win",
          arch: arch as "x64" | "arm64",
          nodeVersion: NODE_VERSION,
        };
      });

/** Generated or vendored trees that no tool should look at. */
const IGNORED = ["build/**", "dist/**", ".alchemy/**", "node_modules/**"];

export default defineConfig({
  fmt: {
    ignorePatterns: IGNORED,
    sortImports: true,
  },

  lint: {
    ignorePatterns: IGNORED,
    options: {
      // The Worker and CLI lean on types heavily; catching misuse without
      // them would miss most of what's worth catching here.
      typeAware: true,
      typeCheck: true,
    },
  },

  // `vp config` installs a pre-commit hook that runs `vp staged`, which
  // applies these to whatever is about to be committed.
  staged: {
    "*.{ts,js,mts,cts}": "vp check --fix",
    "*.{json,md}": "vp fmt --write",
  },

  pack: {
    entry: ["src/cli.ts"],
    // A single executable has no node_modules to fall back on, so nothing may
    // stay external — without this the binary dies on its first import.
    deps: { alwaysBundle: [/.*/] },
    exe: {
      fileName: "ghdrop",
      targets,
      seaConfig: {
        // Required for cross-compilation: code caches and snapshots are tied
        // to the building platform and crash elsewhere on startup.
        useCodeCache: false,
        useSnapshot: false,
      },
    },
  },
});
