// Build self-contained per-platform releases with `bun build --compile`.
//
//   bun run build:release            # both linux-x64 and windows-x64
//   bun run build:release linux      # just one (linux | windows)
//
// A `bun build --compile` binary is NOT a literal single file for this app:
// ffmpeg/ffprobe (and optional whisper-cli / yt-dlp / tar) can't be embedded,
// and the public/ web assets (index.html, app.js, the kuromoji dict) live on
// disk beside the binary. So each release is a folder — binary + sibling
// public/ + a run-README — zipped per platform.
//
// Output:
//   dist/<platform>/zehntage-reactor[.exe]
//   dist/<platform>/public/...
//   dist/<platform>/README.txt
//   dist/zehntage-reactor-<platform>.zip

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { zipDir } from "./zip.ts";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const PUBLIC = join(ROOT, "public");
const ENTRY = join(ROOT, "src", "cli.ts");

interface Target {
  /** dist subdir + zip suffix. */
  platform: string;
  /** bun --target value. */
  bunTarget: string;
  /** output binary name (with platform extension). */
  binName: string;
}

const TARGETS: Record<string, Target> = {
  linux: { platform: "linux-x64", bunTarget: "bun-linux-x64", binName: "zehntage-reactor" },
  windows: {
    platform: "windows-x64",
    bunTarget: "bun-windows-x64",
    binName: "zehntage-reactor.exe",
  },
};

function readme(platform: string, binName: string): string {
  const isWin = platform.startsWith("windows");
  const run = isWin ? `zehntage-reactor.exe "C:\\path\\to\\media"` : `./zehntage-reactor /path/to/media`;
  const ext = isWin ? "Windows" : "Linux";
  return `zehntage-reactor — ${ext} release
=========================================

Japanese-immersion subtitle player. Self-contained Bun binary + web assets.

CONTENTS
  ${binName}      the app (a compiled Bun binary — no Bun/Node needed)
  public/         web UI + kuromoji dictionary (MUST stay beside the binary)
  README.txt      this file

RUN
  ${run}

  Then open the printed http://localhost:8417 URL (it auto-opens your browser;
  set ZR_NO_OPEN=1 to suppress). With no path argument it uses the saved
  mediaRoot, then the current directory.

  Other commands:
    ${binName} subtitle <lang> [<lang2>] <file>   generate sidecar subtitles
    ${binName} backup [<dir>]                      create a backup archive
    ${binName} backups                             list backup archives

REQUIREMENTS (external tools — NOT bundled)
  ffmpeg + ffprobe   REQUIRED for playback (remux), frame capture, audio export.
  whisper-cli        OPTIONAL — local subtitle transcription.
  yt-dlp             OPTIONAL — download/watch YouTube in the library.
  tar                OPTIONAL — backup archives (preinstalled on most systems).

  Put these on your PATH, or drop the executables into this folder${
    isWin ? " (Windows finds them in the working dir)" : ""
  }.
  ${
    isWin
      ? "Windows: get ffmpeg from https://www.gyan.dev/ffmpeg/builds/ and add its\n  bin/ to PATH (or copy ffmpeg.exe + ffprobe.exe here)."
      : "Linux: install via your package manager, e.g. `sudo pacman -S ffmpeg` or\n  `sudo apt install ffmpeg`."
  }

NOTES
  ENV overrides: PORT (default 8417), ZR_NO_OPEN=1 (don't open browser),
  ZR_ASSET_DIR (point at a different public/ folder).
  ${
    isWin
      ? "Windows degrades gracefully without a C compiler (the SQLite unicase\n  extension is Linux-only); search just won't be accent/case-folded."
      : ""
  }
`;
}

async function fileSize(p: string): Promise<number> {
  return (await stat(p)).size;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function buildWeb(): Promise<void> {
  console.log("→ building web assets (build:web)…");
  const proc = Bun.spawn(["bun", "run", "scripts/build-web.ts"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`build:web failed (exit ${code})`);
}

async function compileTarget(t: Target, version: string): Promise<string> {
  const outDir = join(DIST, t.platform);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const binPath = join(outDir, t.binName);
  console.log(`→ compiling ${t.platform} (${t.bunTarget})…`);
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      `--target=${t.bunTarget}`,
      `--define`,
      `ZR_BUILD_VERSION=${JSON.stringify(version)}`,
      ENTRY,
      "--outfile",
      binPath,
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`compile ${t.platform} failed (exit ${code})`);

  // bun may add .exe itself for windows; normalise to the expected name.
  if (!(await Bun.file(binPath).exists())) {
    const alt = t.binName.endsWith(".exe") ? binPath : binPath + ".exe";
    if (await Bun.file(alt).exists()) await cp(alt, binPath);
  }

  // Ship public/ beside the binary (the asset resolver looks here at runtime).
  console.log(`→ copying public/ → ${t.platform}/public…`);
  await cp(PUBLIC, join(outDir, "public"), { recursive: true });

  await Bun.write(join(outDir, "README.txt"), readme(t.platform, t.binName));

  const zipPath = join(DIST, `zehntage-reactor-${t.platform}.zip`);
  console.log(`→ zipping → ${zipPath}…`);
  await zipDir(outDir, zipPath);

  const binMB = fmtMB(await fileSize(binPath));
  const zipMB = fmtMB(await fileSize(zipPath));
  console.log(`✓ ${t.platform}: binary ${binMB}, zip ${zipMB}`);
  return `${t.platform}: binary ${binMB} → ${zipPath} (${zipMB})`;
}

async function main(): Promise<void> {
  const which = process.argv[2];
  const selected = which ? [which] : Object.keys(TARGETS);
  for (const k of selected) {
    if (!TARGETS[k]) throw new Error(`unknown target "${k}" (use: ${Object.keys(TARGETS).join(", ")})`);
  }

  const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as { version?: string };
  const version = pkg.version ?? "0.0.0";

  await mkdir(DIST, { recursive: true });
  await buildWeb();

  const summary: string[] = [];
  for (const k of selected) summary.push(await compileTarget(TARGETS[k]!, version));

  console.log("\nRelease build complete:");
  for (const s of summary) console.log("  " + s);
}

await main();
