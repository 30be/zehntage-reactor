// Pure FSRS-6 scheduler — offline fallback for zehntage-reactor.
//
// Implements the FSRS-6 memory model exactly as specified in
// /tmp/wave14-fsrs-brief.md (formulas) and /tmp/wave18-fsrs-writeback.md
// (the math grounded in the user's real Anki collection).
//
// This module is the REVIEW-STATE math only: initial S/D for new cards,
// recall/lapse stability updates, mean-reverting difficulty, and the
// interval formula. It does NOT manage learning/relearning step queues,
// daily limits, or any Anki DB I/O — see the writeback spec §3 for why that
// belongs to AnkiConnect / the offline DB writer, not to this pure kernel.

/**
 * FSRS-6 parameters for a deck.
 *
 * `decay` is the DECAY *magnitude* (positive), i.e. Anki's stored `data.decay`
 * (= -w[20]). The forgetting-curve exponent used in the math is `-decay`.
 * For this user's deck: w[20]=0.1 → decay=0.1 → exponent -0.1.
 */
export interface FsrsParams {
  /** 21-element FSRS-6 weight vector w[0..20]. */
  w: number[];
  /**
   * DECAY magnitude (positive, required). Curve exponent = -decay.
   * Must be a finite number > 0; a missing or zero decay is a programming error
   * (the value must come from the deck config — e.g. this user's deck uses 0.1).
   * Do NOT pass 0 or omit this field; `schedule` will throw.
   */
  decay: number;
  /** Desired retention r, e.g. 0.9. */
  desiredRetention: number;
  /** Learning step durations in minutes (e.g. [1, 10]). */
  learningSteps: number[];
  /** Relearning step durations in minutes (e.g. [10]). */
  relearningSteps: number[];
  /** Maximum interval clamp in days. Defaults to 36500 when omitted. */
  maxInterval?: number;
}

/**
 * Per-card memory state. `null` for both fields means a brand-new card that
 * has never been reviewed.
 */
export interface CardState {
  /** Stability S in days, or null for a new card. */
  stability: number | null;
  /** Difficulty D in [1,10], or null for a new card. */
  difficulty: number | null;
}

/** Result of a scheduling step. */
export interface ScheduleResult {
  /** Updated stability S' (days, full precision). */
  stability: number;
  /** Updated difficulty D' in [1,10] (full precision). */
  difficulty: number;
  /** Next interval in whole days, clamped to [1, maxInterval]. */
  intervalDays: number;
}

export type Grade = 1 | 2 | 3 | 4; // 1=Again, 2=Hard, 3=Good, 4=Easy

/**
 * Card phase, derived by the caller from the Anki card's queue/type. Controls
 * whether the same-day (intraday) short-term stability path is eligible:
 *
 *   - "new"        — never reviewed; takes the new-card S0/D0 branch.
 *   - "learning"   — in the learning step queue (intraday short-term applies).
 *   - "relearning" — in the relearning step queue (intraday short-term applies).
 *   - "review"     — graduated review-state card; same-day re-grades MUST use
 *                    the long-term recall path, NOT the short-term path.
 *
 * Per FSRS-6 the short-term formula S'_ss is scoped to learning/relearning
 * intraday steps only. The write-path (ankidb dbAnswerCard) passes the real
 * phase; see the `schedule` `phase` parameter.
 */
export type CardPhase = "new" | "learning" | "review" | "relearning";

const DEFAULT_MAX_INTERVAL = 36500;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Guard that decay is a valid positive finite number. A missing or zero decay
 * is a programming error (it must come from the deck config, never defaulted).
 */
function assertDecay(decay: number): void {
  if (!Number.isFinite(decay) || decay <= 0) {
    throw new RangeError(
      `FSRS: decay must be a finite number > 0, got ${decay}. ` +
      `Supply the deck's stored decay (e.g. 0.1) — do not omit or zero it.`,
    );
  }
}

/**
 * Indexed weight access. Under `noUncheckedIndexedAccess` `w[i]` is typed
 * `number | undefined`; a missing weight is a programmer error (the vector
 * must be 21-long), so we surface it loudly rather than silently using NaN.
 */
function wi(w: number[], i: number): number {
  const v = w[i];
  if (v === undefined) {
    throw new RangeError(`FSRS weight w[${i}] is missing (need 21 weights)`);
  }
  return v;
}

/**
 * Compute the FSRS-6 forgetting-curve coefficient FACTOR.
 *
 *   exponent = -decay        (the negative DECAY in the brief)
 *   FACTOR   = 0.9^(1/exponent) - 1     (derived so R(S,S) = 0.9)
 *
 * For decay=0.1: exponent=-0.1, FACTOR = 0.9^(-10) - 1 ≈ 1.8531.
 */
function factorFromDecay(decay: number): number {
  const exponent = -decay;
  return Math.pow(0.9, 1 / exponent) - 1;
}

/**
 * Retrievability R(t, S) = (1 + FACTOR * t/S) ^ DECAY.
 *
 * @param elapsedDays t — days since last review (>= 0).
 * @param stability   S — current stability (days, > 0).
 * @param decay       DECAY magnitude (positive); the exponent applied is -decay.
 * @returns probability of recall in (0, 1]. R = 0.9 exactly when t == S.
 */
export function retrievability(
  elapsedDays: number,
  stability: number,
  decay: number,
): number {
  assertDecay(decay);
  const exponent = -decay;
  const factor = factorFromDecay(decay);
  return Math.pow(1 + factor * (elapsedDays / stability), exponent);
}

/**
 * Interval that achieves the desired retention r given stability S:
 *
 *   I(r, S) = (S / FACTOR) * (r^(1/DECAY) - 1)
 *
 * This is the algebraic inverse of `retrievability`. At r=0.9 it returns S
 * (by definition of stability). Result is the raw real-valued interval in
 * days (NOT yet rounded or clamped — see `schedule` for that).
 *
 * @param stability         S — stability in days.
 * @param desiredRetention  r — target recall probability (e.g. 0.9).
 * @param decay             DECAY magnitude (positive); exponent = -decay.
 */
export function nextInterval(
  stability: number,
  desiredRetention: number,
  decay: number,
): number {
  assertDecay(decay);
  const exponent = -decay;
  const factor = factorFromDecay(decay);
  return (stability / factor) * (Math.pow(desiredRetention, 1 / exponent) - 1);
}

/** Initial difficulty D0(G) = w[4] - e^(w[5]*(G-1)) + 1, clamped to [1,10]. */
function initialDifficulty(w: number[], grade: Grade): number {
  return clamp(wi(w, 4) - Math.exp(wi(w, 5) * (grade - 1)) + 1, 1, 10);
}

/** Initial stability S0(G) = w[G-1]. */
function initialStability(w: number[], grade: Grade): number {
  return wi(w, grade - 1);
}

/**
 * Recall stability update S'_r (Hard/Good/Easy in review state):
 *
 *   S'_r = S * ( e^(w[8]) * (11-D) * S^(-w[9])
 *               * (e^(w[10]*(1-R)) - 1) * HardPenalty * EasyBonus + 1 )
 *
 *   HardPenalty = w[15] if Hard else 1
 *   EasyBonus   = w[16] if Easy else 1
 *
 * Enforced monotone-up on success: S'_r >= S + 0.01.
 */
function recallStability(
  w: number[],
  difficulty: number,
  stability: number,
  retr: number,
  grade: Grade,
): number {
  const hardPenalty = grade === 2 ? wi(w, 15) : 1;
  const easyBonus = grade === 4 ? wi(w, 16) : 1;
  const sInc =
    Math.exp(wi(w, 8)) *
    (11 - difficulty) *
    Math.pow(stability, -wi(w, 9)) *
    (Math.exp(wi(w, 10) * (1 - retr)) - 1) *
    hardPenalty *
    easyBonus;
  const sPrime = stability * (sInc + 1);
  return Math.max(sPrime, stability + 0.01);
}

/**
 * Lapse stability update S'_f (Again in review state):
 *
 *   S'_f = w[11] * D^(-w[12]) * ((S+1)^w[13] - 1) * e^(w[14]*(1-R))
 *
 * Clamped to [0.01, S] (a lapse cannot increase stability).
 */
function lapseStability(
  w: number[],
  difficulty: number,
  stability: number,
  retr: number,
): number {
  const sPrime =
    wi(w, 11) *
    Math.pow(difficulty, -wi(w, 12)) *
    (Math.pow(stability + 1, wi(w, 13)) - 1) *
    Math.exp(wi(w, 14) * (1 - retr));
  return clamp(sPrime, 0.01, stability);
}

/**
 * Same-day / short-term stability S'_ss (used when elapsed t == 0, i.e. the
 * card is reviewed again within learning/relearning the same day):
 *
 *   S'_ss = S * e^(w[17] * (G - 3 + w[18])) * S^(-w[19])
 */
function shortTermStability(
  w: number[],
  stability: number,
  grade: Grade,
): number {
  return (
    stability *
    Math.exp(wi(w, 17) * (grade - 3 + wi(w, 18))) *
    Math.pow(stability, -wi(w, 19))
  );
}

/**
 * Difficulty update for every non-first review:
 *
 *   ΔD = -w[6] * (G - 3)
 *   D' = D + ΔD * (10 - D) / 9          (linear damping toward 10)
 *   D'' = w[7] * D0(4) + (1 - w[7]) * D' (mean-reversion toward Easy baseline)
 *
 * D'' clamped to [1,10].
 */
function nextDifficulty(w: number[], difficulty: number, grade: Grade): number {
  const deltaD = -wi(w, 6) * (grade - 3);
  const dPrime = difficulty + deltaD * (10 - difficulty) / 9;
  const dEasyBaseline = initialDifficulty(w, 4);
  const dDoublePrime = wi(w, 7) * dEasyBaseline + (1 - wi(w, 7)) * dPrime;
  return clamp(dDoublePrime, 1, 10);
}

/**
 * Apply one FSRS-6 review step.
 *
 * New card (state.stability == null || state.difficulty == null):
 *   S' = S0(grade) = w[grade-1]
 *   D' = D0(grade) = clamp(w[4] - e^(w[5]*(grade-1)) + 1, 1, 10)
 *
 * Existing card:
 *   R   = retrievability(elapsedDays, S, decay)
 *   Again (grade 1) → lapse stability S'_f, D'' (harder)
 *   Hard/Good/Easy  → recall stability S'_r, D'' (mean-reverting)
 *   When elapsedDays == 0 (same-day) AND the card is in a learning/relearning
 *   phase, the short-term S'_ss path is used for the non-lapse grades, matching
 *   Anki's learning-step behaviour. A same-day review-state card uses the normal
 *   recall path (FSRS-6 scopes S'_ss to intraday learning/relearning only).
 *
 * The next interval is nextInterval(S', desiredRetention, decay), rounded to
 * the nearest whole day and clamped to [1, maxInterval].
 *
 * @param state        current S/D (null fields = new card)
 * @param grade        1=Again, 2=Hard, 3=Good, 4=Easy
 * @param elapsedDays  whole days since last review (ignored for new cards)
 * @param params       deck FSRS-6 parameters
 * @param phase        optional card phase from the caller (derived from the
 *                     Anki queue/type). Gates the same-day short-term path so it
 *                     applies ONLY for "learning"/"relearning". When omitted,
 *                     behaviour is backward compatible: any same-day non-Again
 *                     grade takes the short-term path (legacy callers). Pass the
 *                     real phase (the write-path does) to get correct FSRS-6
 *                     scoping for review-state cards.
 */
export function schedule(
  state: CardState,
  grade: Grade,
  elapsedDays: number,
  params: FsrsParams,
  phase?: CardPhase,
): ScheduleResult {
  const { w, decay, desiredRetention } = params;
  assertDecay(decay);
  const maxInterval = params.maxInterval ?? DEFAULT_MAX_INTERVAL;

  let stability: number;
  let difficulty: number;

  const isNew = state.stability == null || state.difficulty == null;

  if (isNew) {
    // First review of a new card.
    stability = initialStability(w, grade);
    difficulty = initialDifficulty(w, grade);
  } else {
    const s = state.stability as number;
    const d = state.difficulty as number;
    const retr = retrievability(elapsedDays, s, decay);

    // Short-term (intraday) path is FSRS-6-scoped to learning/relearning only.
    // When `phase` is omitted we preserve the legacy behaviour (any same-day
    // non-Again grade takes short-term) for backward compatibility; when the
    // caller supplies a phase, a "review" (or "new") phase same-day re-grade
    // correctly falls through to the long-term recall path.
    const shortTermEligible =
      phase === undefined || phase === "learning" || phase === "relearning";

    if (grade === 1) {
      // Lapse.
      stability = lapseStability(w, d, s, retr);
    } else if (elapsedDays <= 0 && shortTermEligible) {
      // Same-day success in a learning/relearning step: short-term path.
      stability = shortTermStability(w, s, grade);
    } else {
      // Long-term recall.
      stability = recallStability(w, d, s, retr, grade);
    }
    difficulty = nextDifficulty(w, d, grade);
  }

  const rawInterval = nextInterval(stability, desiredRetention, decay);
  const intervalDays = clamp(Math.round(rawInterval), 1, maxInterval);

  return { stability, difficulty, intervalDays };
}
