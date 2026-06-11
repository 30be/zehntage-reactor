// Build the React frontend into public/app.js + public/app.css and copy the
// kuromoji dictionary into public/dict/. Run: bun run build:web

import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PUBLIC = join(ROOT, "public");
const ENTRY = join(ROOT, "web", "main.tsx");
const DICT_SRC = join(ROOT, "node_modules", "@sglkc", "kuromoji", "dict");
const DICT_DEST = join(PUBLIC, "dict");

async function main() {
  // 1. Bundle JS + CSS via Bun.build.
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: PUBLIC,
    target: "browser",
    minify: true,
    naming: { entry: "app.[ext]", chunk: "[name]-[hash].[ext]", asset: "[name].[ext]" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Bun.build failed");
  }

  // Bun emits main.js / main.css — rename to app.js / app.css.
  const main_js = join(PUBLIC, "main.js");
  const main_css = join(PUBLIC, "main.css");
  if (await Bun.file(main_js).exists()) await rename(main_js, join(PUBLIC, "app.js"));
  if (await Bun.file(main_css).exists()) await rename(main_css, join(PUBLIC, "app.css"));

  // 2. Copy kuromoji dict into public/dict/ (gzipped .dat.gz files; loader gunzips).
  await rm(DICT_DEST, { recursive: true, force: true });
  await mkdir(DICT_DEST, { recursive: true });
  await cp(DICT_SRC, DICT_DEST, { recursive: true });

  const files = await readdir(PUBLIC);
  const dictCount = (await readdir(DICT_DEST)).length;
  console.log("Built:", files.filter((f) => f.startsWith("app.")).join(", "));
  console.log(`Copied ${dictCount} dict files → public/dict/`);
}

await main();
