// zehntage-reactor CLI.
//
//   zehntage-reactor <file.mkv|dir>                 start server, open Chrome
//   zehntage-reactor subtitle <lang> [<lang2>] <f>  headless subtitle generation

import { stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { startServer } from "./server/index.ts";
import { whisperQueue } from "./lib/whisper.ts";
import { parseSrt, cuesToSrt } from "./lib/subs.ts";
import { translateCues } from "./lib/gemini.ts";
import { createBackup, listBackups, defaultBackupDir } from "./lib/backup.ts";

function usage(): never {
  console.error(
    `Usage:
  zehntage-reactor [<file.mkv|dir>]                  start player server
                                                     (no arg: settings.mediaRoot, then cwd)
  zehntage-reactor subtitle <lang> [<lang2>] <file>  generate sidecar subtitles
  zehntage-reactor backup [<dir>]                    create a backup archive
  zehntage-reactor backups                           list backup archives`,
  );
  process.exit(1);
}

/** Same layout as the server's sidecarPath: <videodir>/subs/<base>.<lang>.srt.
 * (Previously wrote next to the video, where the server couldn't find it until
 * a library-scan migration moved it.) */
function sidecarFor(file: string, lang: string): string {
  return join(dirname(file), "subs", `${basename(file, extname(file))}.${lang}.srt`);
}

async function runSubtitle(args: string[]): Promise<void> {
  if (args.length < 2 || args.length > 3) usage();
  const lang = args[0]!;
  const secondLang = args.length === 3 ? args[1]! : null;
  const file = resolve(args[args.length - 1]!);
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) {
    console.error(`Not a file: ${file}`);
    process.exit(1);
  }

  const outPath = sidecarFor(file, lang);
  let cues = null as Awaited<ReturnType<typeof parseSrt>> | null;

  const existing = Bun.file(outPath);
  if (await existing.exists()) {
    console.log(`Reusing existing transcript: ${outPath}`);
    cues = parseSrt(await existing.text());
  } else {
    console.log(`Transcribing (${lang}) → ${outPath}`);
    const job = whisperQueue.enqueue(file, lang, outPath);
    cues = await new Promise((resolvePromise, reject) => {
      job.listeners.add((e) => {
        if (e.type === "cue") {
          const t = Math.floor(e.cue.start);
          process.stdout.write(
            `\r  [${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}] ${e.cue.text.slice(0, 60)}`.padEnd(80) ,
          );
        } else if (e.type === "status") {
          if (e.status === "done") {
            process.stdout.write("\n");
            resolvePromise(job.cues);
          } else if (e.status === "error") {
            reject(new Error(e.error ?? "whisper failed"));
          } else if (e.status !== "queued") {
            console.log(`  ${e.status}...`);
          }
        }
      });
    });
    console.log(`Saved ${cues!.length} cues to ${outPath}`);
  }

  if (secondLang) {
    const outPath2 = sidecarFor(file, secondLang);
    console.log(`Translating ${cues!.length} cues → ${secondLang} (${outPath2})`);
    const translated = await translateCues(cues!, secondLang, (done, total) => {
      process.stdout.write(`\r  ${done}/${total}`);
    });
    process.stdout.write("\n");
    await Bun.write(outPath2, cuesToSrt(translated));
    console.log(`Saved ${outPath2}`);
  }
}

async function runServer(arg?: string): Promise<void> {
  let root: string | undefined;
  if (arg !== undefined) {
    const target = resolve(arg);
    const st = await stat(target).catch(() => null);
    if (!st) {
      console.error(`No such file or directory: ${target}`);
      process.exit(1);
    }
    root = st.isDirectory() ? target : dirname(target);
  }
  // No arg: startServer falls back to settings.mediaRoot, then cwd.
  const handle = await startServer(root, Number(process.env.PORT) || 8417);
  console.log(`zehntage-reactor serving ${handle.root}`);
  console.log(`  ${handle.url}`);
  if (process.env.ZR_NO_OPEN !== "1") {
    Bun.spawn(["xdg-open", handle.url], { stdout: "ignore", stderr: "ignore" }).unref();
  }
}

async function runBackup(args: string[]): Promise<void> {
  if (args.length > 1) usage();
  const destDir = args[0] ? resolve(args[0]) : undefined;
  const { path, manifest } = await createBackup(destDir);
  console.log(`Backup written: ${path}`);
  console.log(`  ${manifest.files.length} files, version ${manifest.version}`);
}

async function runBackupsList(): Promise<void> {
  const backups = await listBackups();
  if (backups.length === 0) {
    console.log(`No backups in ${defaultBackupDir()}`);
    return;
  }
  for (const b of backups) {
    const date = new Date(b.mtimeMs).toISOString().slice(0, 19).replace("T", " ");
    console.log(`${date}  ${String(b.size).padStart(10)}  ${b.path}`);
  }
}

const argv = process.argv.slice(2);

if (argv.length === 0) {
  // No arg: root falls back to settings.mediaRoot, then cwd.
  runServer().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else if (argv[0] === "subtitle") {
  runSubtitle(argv.slice(1))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
} else if (argv[0] === "backup") {
  runBackup(argv.slice(1))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
} else if (argv[0] === "backups") {
  if (argv.length !== 1) usage();
  runBackupsList()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
} else if (argv.length === 1) {
  runServer(argv[0]!).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else {
  usage();
}
