import { describe, expect, it } from 'vitest';

import {
  FX_HALF,
  FX_ONE,
  FX_SHIFT,
  QUARTER_TURN,
  TURN,
  fxAbs,
  fxAtan2,
  fxClamp,
  fxCos,
  fxDiv,
  fxFloorToInt,
  fxFromInt,
  fxFromRatio,
  fxMul,
  fxRoundToInt,
  fxSin,
  fxSqrt,
} from '../src/fx.js';
import { FX_MAGNITUDE_LIMIT, FX_MAX_SQUARABLE } from '../src/constants.js';

/**
 * Tests may use `Math.sin` and friends — they are the reference being checked
 * against, and `test/` is outside the purity gate (which covers `src/` only).
 * `packages/sim/src` may not, and `npm run lint:sim-purity` enforces that.
 */

/** Deterministic xorshift32, so a failure reproduces exactly. Never used in src. */
function* prng(seed: number): Generator<number> {
  let x = seed | 0;
  for (;;) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    yield x | 0;
  }
}

const isInt32 = (v: number): boolean => Object.is(v, v | 0);

/**
 * Exact 16.16 multiply via BigInt, truncating toward zero and wrapping.
 *
 * `/` on BigInt truncates toward zero, where `>>` would floor. That difference
 * is the whole point of the rounding mode fxMul uses — see its doc comment.
 */
const refMul = (a: number, b: number): number =>
  Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) / (1n << BigInt(FX_SHIFT))));

const toFloat = (v: number): number => v / FX_ONE;
const angleToRadians = (a: number): number => (a / TURN) * 2 * Math.PI;

// ---------------------------------------------------------------------------

describe('conversion round-trips', () => {
  it('survives whole numbers across the storage range', () => {
    for (let n = -32_000; n <= 32_000; n += 137) {
      expect(fxFloorToInt(fxFromInt(n))).toBe(n);
    }
  });

  it('floors and rounds in the documented directions', () => {
    expect(fxFloorToInt(FX_ONE + FX_HALF)).toBe(1);
    expect(fxRoundToInt(FX_ONE + FX_HALF)).toBe(2);
    // Toward negative infinity, not toward zero — this is `>>`, and the sim
    // relies on it being consistent rather than convenient.
    expect(fxFloorToInt(-FX_HALF)).toBe(-1);
    expect(fxRoundToInt(-FX_HALF)).toBe(0);
  });

  it('builds exact ratios, which is how tuning constants are authored', () => {
    expect(fxFromRatio(1, 2)).toBe(FX_HALF);
    expect(fxFromRatio(1, 4)).toBe(FX_ONE / 4);
    expect(fxFromRatio(-3, 2)).toBe(-(FX_ONE + FX_HALF));
    // 24 units/second at 30 Hz, the per-tick form described in constants.ts.
    expect(fxFromRatio(24, 30)).toBe(Math.floor(0.8 * FX_ONE));
  });

  it('handles rates far outside the 16.16 storage range', () => {
    // Regression. The original implementation converted both arguments with
    // fxFromInt first, which wraps past ±32_768: the denominator of a small
    // rate wrapped to 0 and the result saturated. Asking for the smallest
    // representable rate returned the largest possible value.
    expect(fxFromRatio(1, 65_536)).toBe(1);
    expect(fxFromRatio(1, 100_000)).toBe(0);
    expect(fxFromRatio(1, 1_000_000)).toBe(0);
    expect(fxFromRatio(1_000_000, 1_000)).toBe(fxFromInt(1_000));
    expect(fxFromRatio(-1, 65_536)).toBe(-1);

    // A rate is never NaN or Infinity, for the same reason fxDiv saturates.
    expect(fxFromRatio(1, 0)).toBe(0x7fffffff);
    expect(fxFromRatio(-1, 0)).toBe(-0x80000000);
  });
});

describe('fxMul', () => {
  it('agrees exactly with a BigInt reference over fuzzed inputs', () => {
    const rng = prng(0x1234_5678);
    for (let i = 0; i < 20_000; i += 1) {
      const a = rng.next().value;
      const b = rng.next().value;
      expect(fxMul(a, b)).toBe(refMul(a, b));
    }
  });

  it('is exact for values inside the arithmetic bound', () => {
    for (let n = -FX_MAX_SQUARABLE; n <= FX_MAX_SQUARABLE; n += 1) {
      const v = fxFromInt(n);
      expect(fxMul(v, v)).toBe(fxFromInt(n * n));
    }
  });

  it('squares the largest squarable value without overflowing', () => {
    const v = fxFromInt(FX_MAX_SQUARABLE);
    expect(fxMul(v, v)).toBe(fxFromInt(FX_MAX_SQUARABLE * FX_MAX_SQUARABLE));
    expect(isInt32(fxMul(v, v))).toBe(true);
  });

  it('wraps rather than saturating one step past the bound', () => {
    // Documented behaviour, asserted so nobody "fixes" it into a silent clamp:
    // past the envelope the answer is wrong, and it is wrong identically
    // everywhere, which is what determinism requires.
    //
    // The truth has to come from BigInt. Writing the expected value as
    // `fxFromInt(182 ** 2)` does not work — that overflows int32 in exactly the
    // same way, so the assertion compares two wrapped values and passes for the
    // wrong reason.
    const over = fxFromInt(FX_MAX_SQUARABLE + 1);
    const exact = (BigInt(over) * BigInt(over)) / (1n << BigInt(FX_SHIFT));

    expect(exact).toBeGreaterThan(2n ** 31n - 1n);
    expect(BigInt(fxMul(over, over))).not.toBe(exact);
    expect(fxMul(over, over)).toBe(refMul(over, over));
  });

  it('is exactly odd, so mirrored inputs give mirrored results', () => {
    // fxMul(-a, b) === -fxMul(a, b), to the unit. A floor-truncating multiply
    // is off by one here, and that one unit compounds through car.ts into a
    // cab that corners 8.5% harder one way than the other.
    const rng = prng(0x5ade_1234);
    for (let i = 0; i < 20_000; i += 1) {
      const a = rng.next().value;
      const b = rng.next().value;
      if (a === -0x80000000 || b === -0x80000000) continue;

      expect(fxMul(-a, b)).toBe(-fxMul(a, b) | 0);
      expect(fxMul(a, -b)).toBe(-fxMul(a, b) | 0);
      expect(fxMul(-a, -b)).toBe(fxMul(a, b));
    }
  });

  it('handles identities and signs', () => {
    const rng = prng(0x9e37_79b9);
    for (let i = 0; i < 2_000; i += 1) {
      const a = rng.next().value;
      expect(fxMul(a, FX_ONE)).toBe(a);
      expect(fxMul(a, 0)).toBe(0);
      expect(fxMul(FX_ONE, a)).toBe(a);
    }
    expect(fxMul(-FX_ONE, FX_ONE)).toBe(-FX_ONE);
    expect(fxMul(-FX_ONE, -FX_ONE)).toBe(FX_ONE);
  });
});

describe('fxDiv', () => {
  it('is the exact truncated quotient over fuzzed inputs', () => {
    const rng = prng(0x0bad_c0de);
    for (let i = 0; i < 20_000; i += 1) {
      const a = rng.next().value;
      const b = rng.next().value;
      if (b === 0) continue;

      const exact = BigInt.asIntN(32, (BigInt(a) * BigInt(FX_ONE)) / BigInt(b));
      expect(fxDiv(a, b)).toBe(Number(exact));
    }
  });

  it('inverts fxMul within one unit of last place', () => {
    const rng = prng(0xfeed_face);
    for (let i = 0; i < 5_000; i += 1) {
      // Keep operands inside the arithmetic bound so the product is meaningful,
      // and keep |b| >= 1.0. Dividing by a small b amplifies fxMul's truncation
      // by FX_ONE/|b| — at b = 0.25 a one-unit error round-trips as four, which
      // is a property of fixed point, not a defect to be tuned away.
      const a = rng.next().value % (FX_MAX_SQUARABLE * FX_ONE);
      const raw = rng.next().value % (FX_MAX_SQUARABLE * FX_ONE);
      const b = raw < 0 ? Math.min(raw, -FX_ONE) : Math.max(raw, FX_ONE);
      expect(Math.abs(fxDiv(fxMul(a, b), b) - a)).toBeLessThanOrEqual(2);
    }
  });

  it('saturates on divide-by-zero instead of producing NaN or Infinity', () => {
    // A NaN here would poison the world hash and desync every client at once.
    expect(fxDiv(FX_ONE, 0)).toBe(0x7fffffff);
    expect(fxDiv(-FX_ONE, 0)).toBe(-0x80000000);
    expect(fxDiv(0, 0)).toBe(0x7fffffff);
    expect(Number.isNaN(fxDiv(FX_ONE, 0))).toBe(false);
  });
});

describe('fxSqrt', () => {
  it('is exact on perfect squares', () => {
    for (let n = 0; n <= 180; n += 1) {
      expect(fxSqrt(fxFromInt(n * n))).toBe(fxFromInt(n));
    }
  });

  it('matches a truncated real square root', () => {
    const rng = prng(0x5eed_1234);
    for (let i = 0; i < 20_000; i += 1) {
      const v = Math.abs(rng.next().value);
      const got = fxSqrt(v);
      const want = Math.floor(Math.sqrt(v * FX_ONE));
      // Allow one unit for the double's own rounding in the reference, not ours.
      expect(Math.abs(got - want)).toBeLessThanOrEqual(1);
      // Truncating, so the result never overshoots.
      expect(got * got).toBeLessThanOrEqual(v * FX_ONE);
    }
  });

  it('returns 0 for zero and negatives rather than NaN', () => {
    expect(fxSqrt(0)).toBe(0);
    expect(fxSqrt(-FX_ONE)).toBe(0);
    expect(fxSqrt(-0x80000000)).toBe(0);
  });

  it('handles the top of the storage range', () => {
    expect(isInt32(fxSqrt(0x7fffffff))).toBe(true);
    expect(toFloat(fxSqrt(0x7fffffff))).toBeCloseTo(Math.sqrt(toFloat(0x7fffffff)), 3);
  });
});

describe('trigonometry', () => {
  it('is correctly rounded across the entire turn', () => {
    // 0.5 is the theoretical floor for a rounded 16.16 table: any larger and
    // the table is not merely quantised, it is wrong. It reached exactly 0.5
    // only after the half-angle sine was rewritten to avoid catastrophic
    // cancellation — see the note in buildSinQuadrant.
    let worstSin = 0;
    let worstCos = 0;
    for (let a = 0; a < TURN; a += 1) {
      worstSin = Math.max(worstSin, Math.abs(fxSin(a) - Math.sin(angleToRadians(a)) * FX_ONE));
      worstCos = Math.max(worstCos, Math.abs(fxCos(a) - Math.cos(angleToRadians(a)) * FX_ONE));
    }
    expect(worstSin).toBeLessThanOrEqual(0.5);
    expect(worstCos).toBeLessThanOrEqual(0.5);
  });

  it('is exact on the axes', () => {
    expect(fxSin(0)).toBe(0);
    expect(fxCos(0)).toBe(FX_ONE);
    expect(fxSin(QUARTER_TURN)).toBe(FX_ONE);
    expect(fxCos(QUARTER_TURN)).toBe(0);
    expect(fxSin(TURN / 2)).toBe(0);
    expect(fxCos(TURN / 2)).toBe(-FX_ONE);
    expect(fxSin(3 * QUARTER_TURN)).toBe(-FX_ONE);
    expect(fxCos(3 * QUARTER_TURN)).toBe(0);
  });

  it('never returns negative zero', () => {
    // -0 compares equal to 0 but is a different bit pattern, so it survives
    // every ordinary assertion and then shows up as a one-client hash mismatch.
    for (let a = 0; a < TURN; a += 1) {
      expect(Object.is(fxSin(a), -0)).toBe(false);
      expect(Object.is(fxCos(a), -0)).toBe(false);
    }
  });

  it('wraps exactly, in both directions and over many turns', () => {
    for (let a = 0; a < TURN; a += 97) {
      expect(fxSin(a + TURN)).toBe(fxSin(a));
      expect(fxSin(a - TURN)).toBe(fxSin(a));
      expect(fxSin(a + 37 * TURN)).toBe(fxSin(a));
      expect(fxCos(a + TURN)).toBe(fxCos(a));
    }
  });

  it('satisfies the Pythagorean identity', () => {
    for (let a = 0; a < TURN; a += 13) {
      const s = toFloat(fxSin(a));
      const c = toFloat(fxCos(a));
      expect(s * s + c * c).toBeCloseTo(1, 4);
    }
  });

  it('relates sin and cos by a quarter turn', () => {
    for (let a = 0; a < TURN; a += 7) {
      expect(fxCos(a)).toBe(fxSin(a + QUARTER_TURN));
    }
  });

  it('is odd in sin and even in cos', () => {
    for (let a = 1; a < TURN; a += 11) {
      expect(fxSin(-a & 0xffff)).toBe(-fxSin(a) | 0);
      expect(fxCos(-a & 0xffff)).toBe(fxCos(a));
    }
  });
});

describe('the trig table is a golden', () => {
  it('hashes to a pinned value across every engine', () => {
    // GOLDEN. This is the first determinism oracle in the project, and the same
    // rule applies as to the S-14 replay goldens: **never edit this constant to
    // make the test pass.** If the table legitimately changes, write an ADR and
    // regenerate deliberately.
    //
    // The "correctly rounded" test above bounds the table's error, but a table
    // could stay inside 0.5 while differing by one unit between two engines —
    // and that difference is a desync. This pins the exact bytes. The table is
    // built with BigInt, which is exact, so it must be identical everywhere.
    let hash = 0x811c9dc5;
    for (let a = 0; a < TURN; a += 1) {
      const v = fxSin(a);
      for (let byte = 0; byte < 4; byte += 1) {
        hash ^= (v >>> (byte * 8)) & 0xff;
        hash = Math.imul(hash, 0x01000193);
      }
    }
    expect(hash >>> 0).toBe(0x235ffdba);
  });
});

describe('fxAtan2', () => {
  it('is exact on the axes', () => {
    expect(fxAtan2(0, FX_ONE)).toBe(0);
    expect(fxAtan2(FX_ONE, 0)).toBe(QUARTER_TURN);
    expect(fxAtan2(0, -FX_ONE)).toBe(TURN / 2);
    expect(fxAtan2(-FX_ONE, 0)).toBe(3 * QUARTER_TURN);
  });

  it('returns 0 at the origin rather than something arbitrary', () => {
    expect(fxAtan2(0, 0)).toBe(0);
  });

  it('round-trips against sin/cos to within one angle unit', () => {
    // The tightest possible claim: the answer is the nearest representable
    // uint16 angle. This is the property S-06 depends on when it derives a
    // velocity heading.
    for (let a = 0; a < TURN; a += 1) {
      const got = fxAtan2(fxSin(a), fxCos(a));
      let delta = Math.abs(got - a);
      if (delta > TURN / 2) delta = TURN - delta;
      expect(delta).toBeLessThanOrEqual(1);
    }
  });

  it('agrees with Math.atan2 across all four quadrants', () => {
    const rng = prng(0xa5a5_1234);
    let worst = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const x = rng.next().value % (1 << 20);
      const y = rng.next().value % (1 << 20);
      if (x === 0 && y === 0) continue;

      const got = fxAtan2(y, x);
      let want = (Math.atan2(y, x) / (2 * Math.PI)) * TURN;
      if (want < 0) want += TURN;

      let delta = Math.abs(got - want);
      if (delta > TURN / 2) delta = TURN - delta;
      worst = Math.max(worst, delta);
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('always returns an in-range uint16 angle', () => {
    const rng = prng(0x1357_9bdf);
    for (let i = 0; i < 20_000; i += 1) {
      const a = fxAtan2(rng.next().value, rng.next().value);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(TURN);
      expect(Number.isInteger(a)).toBe(true);
    }
  });
});

describe('helpers', () => {
  it('fxAbs', () => {
    expect(fxAbs(FX_ONE)).toBe(FX_ONE);
    expect(fxAbs(-FX_ONE)).toBe(FX_ONE);
    expect(fxAbs(0)).toBe(0);
    expect(Object.is(fxAbs(0), -0)).toBe(false);
  });

  it('fxClamp', () => {
    expect(fxClamp(fxFromInt(5), 0, FX_ONE)).toBe(FX_ONE);
    expect(fxClamp(fxFromInt(-5), 0, FX_ONE)).toBe(0);
    expect(fxClamp(FX_HALF, 0, FX_ONE)).toBe(FX_HALF);
  });
});

describe('everything stays int32', () => {
  it('holds for every exported function over fuzzed inputs', () => {
    // The single most important property in this file. A value that silently
    // becomes a non-integer double still behaves like a number, still passes
    // most assertions, and desyncs the moment it is hashed.
    const rng = prng(0x2468_ace0);
    for (let i = 0; i < 20_000; i += 1) {
      const a = rng.next().value;
      const b = rng.next().value;

      expect(isInt32(fxMul(a, b))).toBe(true);
      expect(isInt32(fxDiv(a, b))).toBe(true);
      expect(isInt32(fxSqrt(a))).toBe(true);
      expect(isInt32(fxAbs(a))).toBe(true);
      expect(isInt32(fxSin(a))).toBe(true);
      expect(isInt32(fxCos(a))).toBe(true);
      expect(isInt32(fxAtan2(a, b))).toBe(true);
      expect(isInt32(fxFloorToInt(a))).toBe(true);
      expect(isInt32(fxRoundToInt(a))).toBe(true);
    }
  });
});

describe('the precision envelope holds', () => {
  it('a world-scale coordinate is representable but not squarable', () => {
    const corner = fxFromInt(2048);
    expect(isInt32(corner)).toBe(true);
    expect(2048).toBeLessThan(FX_MAGNITUDE_LIMIT);

    // The warning in constants.ts, demonstrated rather than asserted in prose:
    // the coordinate stores fine, and squaring it does not.
    const exact = (BigInt(corner) * BigInt(corner)) / (1n << BigInt(FX_SHIFT));
    expect(exact).toBeGreaterThan(2n ** 31n - 1n);
    expect(BigInt(fxMul(corner, corner))).not.toBe(exact);
  });
});
