// Asset-directory + version resolution that works in BOTH modes:
//
//   1. `bun run` dev — files live in the repo; import.meta.dir points into src/,
//      so the public/ assets folder is two levels up (../../public).
//
//   2. `bun build --compile` binary — import.meta.dir is the *virtual* path of
//      the bundled module, NOT a real directory on disk, and node_modules does
//      not exist beside the binary. The release ships a sibling public/ folder
//      next to the executable, so we resolve assets relative to process.execPath.
//
// Resolution order for the asset dir:
//   ZR_ASSET_DIR env override  ->  <repo>/public (if it exists, dev)  ->
//   <dir of process.execPath>/public  (compiled binary release layout).
//
// The kuromoji IPADIC dictionary ships in public/dict (build:web copies it), so
// the server tokenizer reads <assetDir>/dict instead of node_modules.
//
// The package version is baked in at compile time via `bun build --define
// ZR_BUILD_VERSION=...`; in dev (where the define is absent) we read it from
// package.json relative to the repo. Either way callers get a string.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Injected by `bun build --define` in scripts/build-release.ts. In `bun run`
// dev this identifier is undefined, so we fall back to reading package.json.
declare const ZR_BUILD_VERSION: string | undefined;

/** The repo's public/ dir during `bun run` dev (../../public from this file). */
function devPublicDir(): string {
  return join(import.meta.dir, "..", "..", "public");
}

let cachedAssetDir: string | null = null;

/**
 * Absolute path to the public/ assets folder (index.html, app.js, dict/, …).
 *
 *   - ZR_ASSET_DIR wins if set (explicit override / tests).
 *   - else the repo public/ if it exists on disk (dev via `bun run`).
 *   - else public/ beside the compiled binary (release ZIP layout).
 */
export function assetDir(): string {
  if (cachedAssetDir) return cachedAssetDir;

  const override = process.env.ZR_ASSET_DIR;
  if (override) {
    cachedAssetDir = override;
    return cachedAssetDir;
  }

  const dev = devPublicDir();
  if (existsSync(dev)) {
    cachedAssetDir = dev;
    return cachedAssetDir;
  }

  // Compiled binary: public/ sits next to the executable.
  cachedAssetDir = join(dirname(process.execPath), "public");
  return cachedAssetDir;
}

/** Path to the kuromoji IPADIC dict shipped inside the asset dir (public/dict). */
export function dictDir(): string {
  return join(assetDir(), "dict");
}

let cachedVersion: string | null = null;

/**
 * App version. Baked in at compile time via `bun build --define`; in dev read
 * from package.json (repo root). Never throws — returns "unknown" on failure.
 */
export async function appVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;

  // Compiled binary: the define replaced this with a string literal.
  if (typeof ZR_BUILD_VERSION === "string" && ZR_BUILD_VERSION) {
    cachedVersion = ZR_BUILD_VERSION;
    return cachedVersion;
  }

  // Dev: read package.json from the repo root (../../ from this file). The
  // asset dir (public/) is sibling to package.json's parent in dev, but the
  // compiled binary never reaches here, so the repo-relative read is safe.
  try {
    const pkg = (await Bun.file(join(import.meta.dir, "..", "..", "package.json")).json()) as {
      version?: string;
    };
    cachedVersion = pkg.version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}
