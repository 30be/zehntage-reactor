// Smoke test: start the server against a real media dir and curl every
// read-only endpoint. Usage: bun run scripts/smoke.ts [dir]

import { startServer } from "../src/server/index.ts";

const dir = process.argv[2] ?? `${process.env.HOME}/Downloads/Hyouka [BDrip]`;
const handle = await startServer(dir, 0);
const base = handle.url;
let failures = 0;

async function check(name: string, path: string, opts?: RequestInit & { expect?: number }) {
  const expect = opts?.expect ?? 200;
  try {
    const resp = await fetch(base + path, opts);
    const ok = resp.status === expect;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} → ${resp.status}`);
    if (!ok) failures++;
    return resp;
  } catch (e) {
    console.log(`FAIL ${name} → ${e}`);
    failures++;
    return null;
  }
}

await check("GET /", "/");
const libResp = await check("GET /api/library", "/api/library");
const lib = (await libResp?.json()) as { id: string; name: string }[] | undefined;
console.log(`  library: ${lib?.length ?? 0} files`);

if (lib && lib.length > 0) {
  const id = lib[0]!.id;
  console.log(`  using ${lib[0]!.name} (${id})`);
  const r = await check("GET /media (range)", `/media/${id}`, {
    headers: { Range: "bytes=0-1023" },
    expect: 206,
  });
  if (r) {
    const buf = await r.arrayBuffer();
    console.log(`  got ${buf.byteLength} bytes, Content-Range: ${r.headers.get("Content-Range")}`);
  }
  await check("GET /api/media/:id/info", `/api/media/${id}/info`);
  const subsResp = await check("GET /api/subs/:id", `/api/subs/${id}`);
  const tracks = (await subsResp?.json()) as { id: string }[] | undefined;
  console.log(`  tracks: ${tracks?.map((t) => t.id).join(", ") || "none"}`);
  if (tracks && tracks.length > 0) {
    const cuesResp = await check(
      "GET /api/subs/:id/:track",
      `/api/subs/${id}/${encodeURIComponent(tracks[0]!.id)}`,
    );
    const cues = (await cuesResp?.json()) as unknown[] | undefined;
    console.log(`  cues in ${tracks[0]!.id}: ${cues?.length ?? 0}`);
  }
}

await check("GET /api/settings", "/api/settings");
await check("GET /api/anki/words", "/api/anki/words");
await check("GET bad media id", "/media/000000000000", { expect: 404 });

handle.stop();
console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
