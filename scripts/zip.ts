// Minimal dependency-free ZIP writer (store / no compression).
//
// Why hand-rolled: `zip` isn't guaranteed on the box, and Bun ships no ZIP
// *creator*. Store-only keeps it correct and trivially portable — the payload
// is a ~50 MB binary plus already-compressed assets (app.js, *.dat.gz), which
// barely shrink under DEFLATE anyway. Standard ZIP (not ZIP64); every entry is
// comfortably < 4 GB, which is the only constraint that matters here.
//
// Layout: [local header + data] per entry, then the central directory, then
// the end-of-central-directory record. DOS date/time is fixed (deterministic
// archives); permissions are stored in the "external attributes" high bits so
// the Unix executable bit survives unzip on Linux/mac.

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  /** POSIX path inside the archive (always forward slashes). */
  name: string;
  data: Uint8Array;
  /** Unix mode bits (e.g. 0o755 for the executable, 0o644 for data). */
  mode: number;
}

/** Recursively collect files under `dir`, named relative to `base`. */
async function collect(dir: string, base: string, out: Entry[]): Promise<void> {
  const names = (await readdir(dir)).sort();
  for (const name of names) {
    const abs = join(dir, name);
    const st = await stat(abs);
    if (st.isDirectory()) {
      await collect(abs, base, out);
    } else if (st.isFile()) {
      const data = new Uint8Array(await Bun.file(abs).arrayBuffer());
      const rel = relative(base, abs).split(/[\\/]/).join("/");
      // Executable bit: keep it for files the OS marked executable.
      const mode = st.mode & 0o111 ? 0o755 : 0o644;
      out.push({ name: rel, data, mode });
    }
  }
}

/** Build a ZIP (store-only) of everything under `srcDir` and write it to `outZip`. */
export async function zipDir(srcDir: string, outZip: string): Promise<void> {
  const entries: Entry[] = [];
  await collect(srcDir, srcDir, entries);

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = ((2021 - 1980) << 9) | (1 << 5) | 1; // 2021-01-01, deterministic

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    // Local file header (30 bytes + name).
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); // signature
    lh.setUint16(4, 20, true); // version needed
    lh.setUint16(6, 0, true); // flags
    lh.setUint16(8, 0, true); // method 0 = store
    lh.setUint16(10, DOS_TIME, true);
    lh.setUint16(12, DOS_DATE, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); // compressed
    lh.setUint32(22, size, true); // uncompressed
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true); // extra len
    const localHeader = new Uint8Array(lh.buffer);

    chunks.push(localHeader, nameBytes, e.data);
    const localOffset = offset;
    offset += localHeader.length + nameBytes.length + e.data.length;

    // Central directory entry (46 bytes + name).
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); // signature
    ch.setUint16(4, (3 << 8) | 20, true); // version made by: Unix (3), zip 2.0
    ch.setUint16(6, 20, true); // version needed
    ch.setUint16(8, 0, true); // flags
    ch.setUint16(10, 0, true); // method
    ch.setUint16(12, DOS_TIME, true);
    ch.setUint16(14, DOS_DATE, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true); // extra len
    ch.setUint16(32, 0, true); // comment len
    ch.setUint16(34, 0, true); // disk number
    ch.setUint16(36, 0, true); // internal attrs
    // External attrs: Unix mode in the high 16 bits (file type 0o100000 | mode).
    ch.setUint32(38, ((0o100000 | e.mode) >>> 0) * 0x10000, true);
    ch.setUint32(42, localOffset, true);
    central.push(new Uint8Array(ch.buffer), nameBytes);
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  // End of central directory record (22 bytes).
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true); // disk
  eocd.setUint16(6, 0, true); // cd start disk
  eocd.setUint16(8, entries.length, true); // entries on this disk
  eocd.setUint16(10, entries.length, true); // total entries
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true); // comment len

  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  let total = 0;
  for (const a of all) total += a.length;
  const buf = new Uint8Array(total);
  let p = 0;
  for (const a of all) {
    buf.set(a, p);
    p += a.length;
  }
  await Bun.write(outZip, buf);
}
