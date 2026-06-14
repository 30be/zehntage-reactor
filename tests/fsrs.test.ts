// Unit tests for src/lib/fsrs.ts — the pure FSRS-6 scheduler kernel.
//
// All expected S'/D'/interval values are computed BY HAND from the formulas in
// /tmp/wave14-fsrs-brief.md and pinned here (cross-checked against an
// independent reference implementation). Deterministic — no Date.now, no I/O.

import { describe, expect, test } from "bun:test";
import {
  schedule,
  retrievability,
  nextInterval,
  type FsrsParams,
  type CardState,
  type Grade,
} from "../src/lib/fsrs.ts";

// FSRS-6 default weight vector w[0..20] from the brief §4.
const W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  0.1542,
];

// Deck params using the brief's default decay magnitude (0.1542).
const PARAMS: FsrsParams = {
  w: W,
  decay: 0.1542,
  desiredRetention: 0.9,
  learningSteps: [1, 10],
  relearningSteps: [10],
};

// Tolerance for float comparisons.
const EPS = 1e-9;

function approx(actual: number, expected: number, eps = EPS) {
  expect(Math.abs(actual - expected)).toBeLessThan(eps);
}

describe("retrievability", () => {
  test("R = 0.9 exactly when elapsed == stability", () => {
    approx(retrievability(50, 50, 0.1542), 0.9, 1e-12);
    approx(retrievability(10, 10, 0.1), 0.9, 1e-12);
    approx(retrievability(1, 1, 0.3), 0.9, 1e-12);
  });

  test("R = 1 at elapsed 0", () => {
    approx(retrievability(0, 50, 0.1542), 1, 1e-12);
  });

  test("R decreases as elapsed grows past stability", () => {
    const r1 = retrievability(50, 50, 0.1542);
    const r2 = retrievability(100, 50, 0.1542);
    expect(r2).toBeLessThan(r1);
  });
});

describe("nextInterval", () => {
  test("interval == stability at desired retention 0.9", () => {
    approx(nextInterval(50, 0.9, 0.1542), 50, 1e-9);
    approx(nextInterval(10, 0.9, 0.1), 10, 1e-9);
  });

  test("lower retention => longer interval than S", () => {
    expect(nextInterval(50, 0.85, 0.1542)).toBeGreaterThan(50);
  });

  test("higher retention => shorter interval than S", () => {
    expect(nextInterval(50, 0.95, 0.1542)).toBeLessThan(50);
  });

  test("is inverse of retrievability", () => {
    const S = 37;
    const r = 0.85;
    const t = nextInterval(S, r, 0.1542);
    approx(retrievability(t, S, 0.1542), r, 1e-9);
  });
});

describe("new card initial stability/difficulty", () => {
  // S0(G) = w[G-1]; D0(G) = clamp(w[4] - e^(w[5]*(G-1)) + 1, 1, 10).
  const cases: Array<{
    g: Grade;
    s0: number;
    d0: number;
    interval: number;
  }> = [
    { g: 1, s0: 0.212, d0: 6.4133, interval: 1 }, // raw I=0.212 -> clamped to 1
    { g: 2, s0: 1.2931, d0: 5.112170705601055, interval: 1 },
    { g: 3, s0: 2.3065, d0: 2.118103970459015, interval: 2 },
    { g: 4, s0: 8.2956, d0: 1, interval: 8 }, // D0 clamps to 1
  ];

  for (const c of cases) {
    test(`grade ${c.g}: S0 = w[${c.g - 1}], D0 pinned`, () => {
      const newCard: CardState = { stability: null, difficulty: null };
      const res = schedule(newCard, c.g, 0, PARAMS);
      approx(res.stability, c.s0);
      approx(res.difficulty, c.d0, 1e-12);
      expect(res.intervalDays).toBe(c.interval);
    });
  }

  test("S0 equals w[grade-1] verbatim", () => {
    for (const g of [1, 2, 3, 4] as Grade[]) {
      const res = schedule({ stability: null, difficulty: null }, g, 0, PARAMS);
      approx(res.stability, W[g - 1]!);
    }
  });

  test("interval >= 1 even when raw interval rounds to 0 (Again)", () => {
    const res = schedule({ stability: null, difficulty: null }, 1, 0, PARAMS);
    // raw I(0.212, 0.9) = 0.212 -> round 0 -> clamped to 1
    expect(res.intervalDays).toBe(1);
  });
});

describe("known card review update (S=10, D=5, elapsed=10)", () => {
  // R(10,10) = 0.9 exactly. Expected values pinned from the formulas.
  const base: CardState = { stability: 10, difficulty: 5 };
  const t = 10;

  test("retrievability at elapsed==stability is 0.9", () => {
    approx(retrievability(t, 10, PARAMS.decay), 0.9, 1e-12);
  });

  test("Hard (grade 2): recall stability + harder difficulty", () => {
    const res = schedule(base, 2, t, PARAMS);
    approx(res.stability, 23.246875110466817, 1e-9);
    approx(res.difficulty, 6.671767, 1e-6);
    expect(res.intervalDays).toBe(23);
  });

  test("Good (grade 3): recall stability, near-stable difficulty", () => {
    const res = schedule(base, 3, t, PARAMS);
    approx(res.stability, 32.02672948198673, 1e-9);
    approx(res.difficulty, 4.996, 1e-6);
    expect(res.intervalDays).toBe(32);
  });

  test("Easy (grade 4): recall stability w/ EasyBonus, easier difficulty", () => {
    const res = schedule(base, 4, t, PARAMS);
    approx(res.stability, 51.25386164681294, 1e-9);
    approx(res.difficulty, 3.320233, 1e-6);
    expect(res.intervalDays).toBe(51);
  });

  test("Again (grade 1): lapse stability <= S, harder difficulty", () => {
    const res = schedule(base, 1, t, PARAMS);
    approx(res.stability, 1.3919869729546932, 1e-9);
    approx(res.difficulty, 8.347534, 1e-6);
    expect(res.intervalDays).toBe(1);
    expect(res.stability).toBeLessThanOrEqual(base.stability!);
  });
});

describe("invariants", () => {
  test("difficulty always clamped to [1,10]", () => {
    // Repeated Again should drive D up but never above 10.
    let st: CardState = { stability: 5, difficulty: 9.9 };
    for (let i = 0; i < 20; i++) {
      const r = schedule(st, 1, 5, PARAMS);
      expect(r.difficulty).toBeLessThanOrEqual(10);
      expect(r.difficulty).toBeGreaterThanOrEqual(1);
      st = { stability: r.stability, difficulty: r.difficulty };
    }
    // Repeated Easy should drive D down but never below 1.
    st = { stability: 5, difficulty: 1.1 };
    for (let i = 0; i < 20; i++) {
      const r = schedule(st, 4, 5, PARAMS);
      expect(r.difficulty).toBeGreaterThanOrEqual(1);
      expect(r.difficulty).toBeLessThanOrEqual(10);
      st = { stability: r.stability, difficulty: r.difficulty };
    }
  });

  test("recall stability strictly increases on success", () => {
    const st: CardState = { stability: 10, difficulty: 5 };
    for (const g of [2, 3, 4] as Grade[]) {
      const r = schedule(st, g, 10, PARAMS);
      expect(r.stability).toBeGreaterThanOrEqual(st.stability! + 0.01);
    }
  });

  test("lapse stability never exceeds prior stability, >= 0.01", () => {
    const st: CardState = { stability: 10, difficulty: 5 };
    const r = schedule(st, 1, 10, PARAMS);
    expect(r.stability).toBeLessThanOrEqual(st.stability!);
    expect(r.stability).toBeGreaterThanOrEqual(0.01);
  });

  test("interval clamped to [1, maxInterval]", () => {
    const small = schedule({ stability: 0.01, difficulty: 9 }, 1, 1, PARAMS);
    expect(small.intervalDays).toBeGreaterThanOrEqual(1);

    const capped = schedule(
      { stability: 1e9, difficulty: 1 },
      4,
      1,
      { ...PARAMS, maxInterval: 100 },
    );
    expect(capped.intervalDays).toBe(100);

    // default maxInterval = 36500 when omitted
    const defCap = schedule({ stability: 1e12, difficulty: 1 }, 3, 1, PARAMS);
    expect(defCap.intervalDays).toBe(36500);
  });
});

describe("monotonicity across grades", () => {
  test("Easy interval > Good > Hard (same card)", () => {
    const st: CardState = { stability: 10, difficulty: 5 };
    const hard = schedule(st, 2, 10, PARAMS).intervalDays;
    const good = schedule(st, 3, 10, PARAMS).intervalDays;
    const easy = schedule(st, 4, 10, PARAMS).intervalDays;
    expect(easy).toBeGreaterThan(good);
    expect(good).toBeGreaterThan(hard);
  });

  test("Easy stability > Good > Hard > Again (same card)", () => {
    const st: CardState = { stability: 10, difficulty: 5 };
    const again = schedule(st, 1, 10, PARAMS).stability;
    const hard = schedule(st, 2, 10, PARAMS).stability;
    const good = schedule(st, 3, 10, PARAMS).stability;
    const easy = schedule(st, 4, 10, PARAMS).stability;
    expect(easy).toBeGreaterThan(good);
    expect(good).toBeGreaterThan(hard);
    expect(hard).toBeGreaterThan(again);
  });
});

describe("same-day (elapsed 0) short-term path", () => {
  // S'_ss(S,G) = S * e^(w[17]*(G-3+w[18])) * S^(-w[19]).
  test("uses short-term stability for success at elapsed 0 (S=5)", () => {
    const st: CardState = { stability: 5, difficulty: 5 };
    approx(schedule(st, 2, 0, PARAMS).stability, 2.7470095889223867, 1e-9);
    approx(schedule(st, 3, 0, PARAMS).stability, 4.725686766522371, 1e-9);
    approx(schedule(st, 4, 0, PARAMS).stability, 8.129609559916112, 1e-9);
  });

  test("Again at elapsed 0 still uses lapse path (<= S)", () => {
    const st: CardState = { stability: 5, difficulty: 5 };
    const r = schedule(st, 1, 0, PARAMS);
    expect(r.stability).toBeLessThanOrEqual(5);
  });
});

describe("user's real deck params (decay=0.1, w[20]=0.1)", () => {
  // Writeback §1.3: this deck uses decay magnitude 0.1, FACTOR ≈ 1.868.
  const userW = [
    0.22, 0.7243, 1.6576, 3.3556, 6.2593, 0.2877, 2.4553, 0.0149, 1.6987, 0.0,
    0.7055, 1.2231, 0.1882, 0.3043, 1.6918, 0.5783, 1.9006, 1.0118, 0.4073,
    0.0393, 0.1,
  ];
  const userParams: FsrsParams = {
    w: userW,
    decay: 0.1,
    desiredRetention: 0.9,
    learningSteps: [1, 10],
    relearningSteps: [10],
  };

  test("interval == stability at r=0.9 for this deck", () => {
    approx(nextInterval(100, 0.9, 0.1), 100, 1e-9);
  });

  test("new Good card matches w[2]", () => {
    const res = schedule(
      { stability: null, difficulty: null },
      3,
      0,
      userParams,
    );
    approx(res.stability, 1.6576);
  });
});
