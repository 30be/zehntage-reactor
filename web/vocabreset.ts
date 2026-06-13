// One-time, version-gated reset of the persisted vocabulary state.
//
// The known-set / blacklist keys changed shape with homograph-aware vocabKey
// (lemma → `lemma|reading|pos`). Old zr.known / zr.blacklist entries are under
// the OLD bare-lemma format and would half-match the new keys, so — with the
// user's explicit approval of a clean reset — we drop them ONCE when the stored
// vocab-key version doesn't match the current one. Bump VOCAB_KEY_VERSION if the
// vocabKey shape ever changes again.

const VERSION_KEY = "zr.vocabKeyVersion";
const VOCAB_KEY_VERSION = "homograph-v1";

export function migrateVocabState(): void {
  try {
    if (localStorage.getItem(VERSION_KEY) === VOCAB_KEY_VERSION) return;
    // Stale-format vocab state: clear it so the user starts fresh rather than
    // seeing corrupted half-matches against the new homograph keys.
    localStorage.removeItem("zr.known");
    localStorage.removeItem("zr.blacklist");
    // Drop every cached coverage entry (any version) — they were computed
    // against the old keys; the v4 prefix change already misses them, this just
    // reclaims the space.
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("zr.cov.")) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
    localStorage.setItem(VERSION_KEY, VOCAB_KEY_VERSION);
  } catch {
    /* private mode / no storage — nothing to migrate */
  }
}
