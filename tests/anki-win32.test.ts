// ---------------------------------------------------------------------------
// Cross-platform (win32) bits of the Anki write path:
//   - collectionPath() (src/lib/ankidb.ts): on win32 it resolves the
//     %APPDATA%\Anki2\User 1\collection.anki2 profile path (falling back to
//     ~/AppData/Roaming when APPDATA is unset); on linux/mac the
//     ~/.local/share/Anki2/... path. An explicit ZEHNTAGE_ANKI_DB always wins.
//   - ankiRunning() (src/lib/ankilock.ts): on win32 (/proc absent) it shells out
//     to `tasklist /FI "IMAGENAME eq anki.exe" /NH` and reports a hit when the
//     output mentions anki.exe.
//
// We override process.platform (read-only but configurable) and spy on
// node:fs.readdirSync / node:child_process.execFileSync so NO real /proc scan,
// tasklist, or collection access happens. NOTE: node:path.join uses the HOST
// OS separator regardless of process.platform, so collectionPath assertions are
// built with the same join() the source uses (host-OS-agnostic) rather than a
// hardcoded backslash string.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectionPath } from "../src/lib/ankidb.ts";
import { ankiRunning } from "../src/lib/ankilock.ts";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
});

// ---------------------------------------------------------------------------
describe("collectionPath — platform routing", () => {
  test("win32 uses %APPDATA%\\Anki2\\User 1\\collection.anki2", () => {
    setPlatform("win32");
    const appData = "C:\\Users\\me\\AppData\\Roaming";
    const old = process.env.APPDATA;
    const oldDb = process.env.ZEHNTAGE_ANKI_DB;
    delete process.env.ZEHNTAGE_ANKI_DB;
    process.env.APPDATA = appData;
    try {
      // Built with the same join() the source uses → asserts the APPDATA root +
      // Anki2 / "User 1" / collection.anki2 segments without depending on the
      // host separator (path.join is fixed to the real OS at module load).
      expect(collectionPath()).toBe(
        join(appData, "Anki2", "User 1", "collection.anki2"),
      );
      // Sanity: it is rooted at APPDATA and names the Anki2 profile collection.
      expect(collectionPath().startsWith(appData)).toBe(true);
      expect(collectionPath()).toContain("Anki2");
      expect(collectionPath()).toContain("collection.anki2");
    } finally {
      if (old === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = old;
      if (oldDb !== undefined) process.env.ZEHNTAGE_ANKI_DB = oldDb;
    }
  });

  test("win32 with APPDATA unset falls back to ~/AppData/Roaming", () => {
    setPlatform("win32");
    const old = process.env.APPDATA;
    const oldDb = process.env.ZEHNTAGE_ANKI_DB;
    delete process.env.ZEHNTAGE_ANKI_DB;
    delete process.env.APPDATA;
    try {
      expect(collectionPath()).toBe(
        join(homedir(), "AppData", "Roaming", "Anki2", "User 1", "collection.anki2"),
      );
    } finally {
      if (old !== undefined) process.env.APPDATA = old;
      if (oldDb !== undefined) process.env.ZEHNTAGE_ANKI_DB = oldDb;
    }
  });

  test("linux/mac uses ~/.local/share/Anki2/User 1/collection.anki2", () => {
    setPlatform("linux");
    const oldDb = process.env.ZEHNTAGE_ANKI_DB;
    delete process.env.ZEHNTAGE_ANKI_DB;
    try {
      expect(collectionPath()).toBe(
        join(homedir(), ".local", "share", "Anki2", "User 1", "collection.anki2"),
      );
    } finally {
      if (oldDb !== undefined) process.env.ZEHNTAGE_ANKI_DB = oldDb;
    }
  });

  test("ZEHNTAGE_ANKI_DB overrides every platform", () => {
    const oldDb = process.env.ZEHNTAGE_ANKI_DB;
    process.env.ZEHNTAGE_ANKI_DB = "/custom/path/collection.anki2";
    try {
      setPlatform("win32");
      expect(collectionPath()).toBe("/custom/path/collection.anki2");
      setPlatform("linux");
      expect(collectionPath()).toBe("/custom/path/collection.anki2");
    } finally {
      if (oldDb === undefined) delete process.env.ZEHNTAGE_ANKI_DB;
      else process.env.ZEHNTAGE_ANKI_DB = oldDb;
    }
  });
});

// ---------------------------------------------------------------------------
// ankiRunning win32 branch. We make the /proc scan throw (readdirSync) so the
// `scanned` flag stays false and control reaches the platform-specific
// fallback, then drive process.platform + a mocked tasklist.
function withWin32NoProc(
  taskOutput: string | Error,
  fn: (captured: { cmd?: unknown; args?: unknown }) => void,
) {
  setPlatform("win32");
  const captured: { cmd?: unknown; args?: unknown } = {};
  const readdir = spyOn(fs, "readdirSync").mockImplementation((() => {
    throw new Error("ENOENT: /proc not available on win32");
  }) as typeof fs.readdirSync);
  const exec = spyOn(childProcess, "execFileSync").mockImplementation(((
    cmd: unknown,
    args: unknown,
  ) => {
    captured.cmd = cmd;
    captured.args = args;
    if (taskOutput instanceof Error) throw taskOutput;
    return taskOutput;
  }) as typeof childProcess.execFileSync);
  try {
    fn(captured);
  } finally {
    readdir.mockRestore();
    exec.mockRestore();
  }
}

describe("ankiRunning — win32 tasklist detection", () => {
  test("anki.exe present in tasklist output → running (true)", () => {
    withWin32NoProc(
      "anki.exe                      1234 Console                 1     50,000 K\n",
      (cap) => {
        expect(ankiRunning("C:\\Users\\me\\AppData\\Roaming\\Anki2\\User 1\\collection.anki2")).toBe(
          true,
        );
        // Probed exactly the documented tasklist filter.
        expect(cap.cmd).toBe("tasklist");
        expect(cap.args).toEqual(["/FI", "IMAGENAME eq anki.exe", "/NH"]);
      },
    );
  });

  test("case-insensitive match (ANKI.EXE) → running", () => {
    withWin32NoProc("ANKI.EXE   9999 Console 1 40,000 K\n", () => {
      expect(ankiRunning()).toBe(true);
    });
  });

  test("tasklist 'No tasks' line → not running (false)", () => {
    withWin32NoProc(
      "INFO: No tasks are running which match the specified criteria.\n",
      () => {
        expect(ankiRunning()).toBe(false);
      },
    );
  });

  test("tasklist missing / throws → not running (no crash)", () => {
    withWin32NoProc(new Error("'tasklist' is not recognized"), () => {
      expect(ankiRunning()).toBe(false);
    });
  });
});
