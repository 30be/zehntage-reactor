// Pure stats formatting helpers (no React/DOM). Bun-testable.

export function localDateStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function fmtMin(sec: number): string {
  return `${Math.round(sec / 60)} min`;
}

/** Returns shade bucket 0–4 for activity grid cells. */
export function activityShade(min: number): number {
  return min <= 0 ? 0 : min < 10 ? 1 : min < 30 ? 2 : min < 60 ? 3 : 4;
}
