import { describe, expect, test } from "bun:test";
import {
  registerCommands,
  allCommands,
  filterCommands,
  onCommandsChange,
  HOTKEYS,
  type Command,
} from "../web/commands.ts";

const cmd = (id: string, title: string, when?: () => boolean): Command => ({
  id,
  title,
  when,
  run: () => {},
});

describe("commands registry", () => {
  test("register / unregister round-trip", () => {
    const off = registerCommands("t1", [cmd("a", "alpha"), cmd("b", "beta")]);
    expect(allCommands().map((c) => c.id)).toEqual(["a", "b"]);
    off();
    expect(allCommands()).toEqual([]);
  });

  test("when() filters context-dependent commands", () => {
    let on = false;
    const off = registerCommands("t2", [cmd("x", "x", () => on), cmd("y", "y")]);
    expect(allCommands().map((c) => c.id)).toEqual(["y"]);
    on = true;
    expect(allCommands().map((c) => c.id)).toEqual(["x", "y"]);
    off();
  });

  test("re-registering a scope replaces it; stale cleanup is a no-op", () => {
    const off1 = registerCommands("t3", [cmd("a", "one")]);
    const off2 = registerCommands("t3", [cmd("b", "two")]);
    off1(); // stale — must NOT remove the newer registration
    expect(allCommands().map((c) => c.id)).toEqual(["b"]);
    off2();
    expect(allCommands()).toEqual([]);
  });

  test("change listeners fire on register/unregister", () => {
    let n = 0;
    const unsub = onCommandsChange(() => n++);
    const off = registerCommands("t4", [cmd("a", "a")]);
    off();
    unsub();
    expect(n).toBe(2);
  });

  test("filterCommands: case-insensitive substring over titles", () => {
    const list = [cmd("1", "player: toggle Hard mode"), cmd("2", "go: stats")];
    expect(filterCommands(list, "hard").map((c) => c.id)).toEqual(["1"]);
    expect(filterCommands(list, "STATS").map((c) => c.id)).toEqual(["2"]);
    expect(filterCommands(list, "  ").length).toBe(2);
    expect(filterCommands(list, "zzz")).toEqual([]);
  });
});

describe("HOTKEYS cheatsheet data", () => {
  test("covers the new bindings", () => {
    const keys = HOTKEYS.map((h) => h.keys).join(" | ");
    expect(keys).toContain("Ctrl+K");
    expect(keys).toContain("?");
    expect(keys).toContain("Shift+- / Shift+=");
  });
});
