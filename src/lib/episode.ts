// Best-effort episode-number parsing from a video filename. Shared by the web
// JimakuFind UI and the server's jimaku-first auto-fetch. Pure (no DOM/browser
// deps) so both sides can import it.

/** Best-effort episode number from a video filename (release tags stripped).
 *  null if none/ambiguous. */
export function guessEpisode(name: string): number | null {
  const clean = name
    .replace(/\.[^.]+$/, "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\b\d{3,4}p\b|\bx26[45]\b|\b10.?bit\b/gi, " ");
  const m =
    clean.match(/(?:e|ep|episode|第)\s*0*(\d{1,3})/i) ??
    clean.match(/(?:^|[\s._-])0*(\d{1,3})(?:v\d)?(?=[\s._-]*$)/);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
}
