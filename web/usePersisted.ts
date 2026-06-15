// Shared hooks for the zr.* localStorage-backed UI prefs. Every site that used
// to inline the `useState(() => { try { getItem } catch })` +
// `setItem` try/catch dance now goes through here. Behavior is byte-identical to
// the old inline blocks: the boolean is stored as "1"/"0"; a missing key yields
// the supplied default; all storage access is wrapped in try/catch so private
// mode / quota errors never break the in-session toggle.
import { useCallback, useState } from "react";

/** Read a "1"/"0" boolean pref; missing/unreadable key -> `def`. */
export function readBoolPref(key: string, def: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? def : raw === "1";
  } catch {
    return def;
  }
}

/** Persist a boolean pref as "1"/"0"; storage errors are swallowed. */
export function writeBoolPref(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* storage may be unavailable (private mode / quota) — ignore */
  }
}

/**
 * A boolean toggle persisted under `key` in localStorage (zr.* prefs).
 *
 * Returns `[value, setValue, toggle]` where:
 *  - `setValue(next)` updates state and writes through to storage.
 *  - `toggle()` flips the current value (and writes through).
 *
 * `onChange` (if given) runs with the NEW value after each change — used by
 * sites that fire a toast or other side-effect on toggle. Pass a stable
 * (memoized) callback if you supply one.
 */
export function usePersistedToggle(
  key: string,
  def: boolean,
  onChange?: (next: boolean) => void,
): [boolean, (next: boolean) => void, () => void] {
  const [value, setRaw] = useState<boolean>(() => readBoolPref(key, def));

  const setValue = useCallback(
    (next: boolean) => {
      setRaw(() => {
        writeBoolPref(key, next);
        onChange?.(next);
        return next;
      });
    },
    [key, onChange],
  );

  const toggle = useCallback(() => {
    setRaw((prev) => {
      const next = !prev;
      writeBoolPref(key, next);
      onChange?.(next);
      return next;
    });
  }, [key, onChange]);

  return [value, setValue, toggle];
}
