// Headless verification of the built web UI against a real media dir.
// Starts the server, curls "/", the bundle assets, a dict file, and the
// library endpoint. Usage: bun run scripts/check-web.ts [dir]

import { startServer } from "../src/server/index.ts";

const dir = process.argv[2] ?? `${process.env.HOME}/Downloads/Hyouka [BDrip]`;
const handle = await startServer(dir, 0);
const base = handle.url;
let failures = 0;

async function check(name: string, path: string, want = 200) {
  try {
    const r = await fetch(base + path);
    const ok = r.status === want;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} → ${r.status}`);
    if (!ok) failures++;
    return r;
  } catch (e) {
    console.log(`FAIL ${name} → ${e}`);
    failures++;
    return null;
  }
}

const indexResp = await check("GET / (SPA)", "/");
const html = (await indexResp?.text()) ?? "";
const refsBundle = html.includes("/app.js") && html.includes("/app.css");
console.log(`${refsBundle ? "PASS" : "FAIL"} index.html references bundle`);
if (!refsBundle) failures++;
const hasRoot = html.includes('id="root"');
console.log(`${hasRoot ? "PASS" : "FAIL"} index.html has #root mount`);
if (!hasRoot) failures++;

await check("GET /app.js", "/app.js");
await check("GET /app.css", "/app.css");
await check("GET /dict/base.dat.gz", "/dict/base.dat.gz");

const lib = await check("GET /api/library", "/api/library");
const entries = (await lib?.json()) as { id: string; name: string }[] | undefined;
console.log(`  library: ${entries?.length ?? 0} files`);

handle.stop();
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll web checks passed.");
