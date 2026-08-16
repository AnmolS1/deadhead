/**
 * `fx.ts` — 16.16 fixed-point arithmetic and an integer trig table.
 *
 * Every number in simulation state is an `int32` interpreted as a 16.16 fixed
 * point value: raw `D` encodes `d = D / 2^16`. This module is the only place
 * that arithmetic happens, so it is the only place a determinism bug can hide.
 *
 * ## Why not just use doubles
 *
 * IEEE 754 `+ - * /` are exactly specified and would in fact be deterministic.
 * `Math.sin`, `Math.cos`, `Math.atan2`, `Math.pow` and friends are **not** —
 * the ECMAScript spec calls them implementation-approximated, so two engines
 * may legitimately return different bits for the same input. A sim that ran in
 * one browser and disagreed with the Durable Object by one ULP would diverge
 * within seconds. So the trig here comes from an integer table, and everything
 * hashed or transmitted is an integer.
 *
 * ## Doubles are still used — as exact integers
 *
 * JavaScript has no int64, so `fxDiv` and `fxSqrt` compute intermediates as
 * `Number`. That is safe, and deliberately so: every intermediate below stays
 * under 2^53, where IEEE 754 integer arithmetic is *exact* and `+ - * / %` are
 * exactly-rounded and therefore identical in every conforming engine. No
 * approximated operation is used anywhere. Read a `Number` in this file as
 * "an integer that happens not to fit in int32", never as a float.
 *
 * ## Precision envelope
 *
 * Restated from `constants.ts`, because this is where it bites:
 *
 * - **Storage:** `|d| < 32_768` ({@link FX_MAGNITUDE_LIMIT}, exclusive).
 * - **Arithmetic:** `|d| <= 181` ({@link FX_MAX_SQUARABLE}) for anything that
 *   gets squared. `fxMul(D, D)` produces raw `d^2 * 2^16`, which must fit in an
 *   int32. This is a limit of the representation — a 64-bit intermediate does
 *   not help, because the *result* does not fit either.
 *
 * **A squared distance may only ever be taken over a relative offset, never
 * over absolute coordinates.** With a world half-extent of 2048, two corners of
 * the map are ~5793 units apart, which is 32x past the squarable bound. Take
 * offsets inside a spatial-hash cell, or compare Chebyshev distance.
 *
 * {@link fxMul} wraps on overflow rather than saturating, because wrapping is
 * one instruction and identical everywhere, while saturation costs a branch on
 * every multiply and merely disguises the bug. Stay inside the envelope.
 *
 * ## Angles
 *
 * An angle is a `uint16` **turn**: 0…65535 spans one revolution, so wrapping is
 * a free `& 0xffff` and is exact. There is no `Math.PI` here and no radians.
 * {@link TURN} / 4 is a right angle, exactly.
 */

export const FX_SHIFT = 16;

/** 1.0 in 16.16. */
export const FX_ONE = 1 << FX_SHIFT;

/** 0.5 in 16.16. Used for round-half-up. */
export const FX_HALF = FX_ONE >> 1;

/** Angle units in one revolution. Angles are `uint16`, so this is also the wrap mask + 1. */
export const TURN = 65536;

/** A right angle, exactly. */
export const QUARTER_TURN = TURN >> 2;

/** Largest int32. Returned by {@link fxDiv} on divide-by-zero. */
const INT32_MAX = 0x7fffffff;

/** Smallest int32. */
const INT32_MIN = -0x80000000;

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** Whole number → 16.16. Wraps if `n` is outside the storage bound. */
export function fxFromInt(n: number): number {
  return (n << FX_SHIFT) | 0;
}

/** 16.16 → whole number, rounding toward negative infinity. */
export function fxFloorToInt(v: number): number {
  return v >> FX_SHIFT;
}

/** 16.16 → whole number, rounding half up. */
export function fxRoundToInt(v: number): number {
  return (v + FX_HALF) >> FX_SHIFT;
}

/**
 * `num / den` as 16.16, computed exactly.
 *
 * This is how a human-readable tuning value becomes a sim constant — e.g. a top
 * speed of 24 units/second at 30 Hz is `fxFromRatio(24, 30)` units per tick. Do
 * the conversion at authoring time, never per tick. See `constants.ts` on why
 * there is no fixed-point `FIXED_DT` to multiply by.
 */
export function fxFromRatio(num: number, den: number): number {
  return fxDiv(fxFromInt(num), fxFromInt(den));
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/**
 * 16.16 multiply, truncating toward negative infinity, wrapping on overflow.
 *
 * The 64-bit product is assembled from four 16x16 partial products so that no
 * intermediate exceeds what `Math.imul` computes exactly:
 *
 * ```text
 *   (ah·2^16 + al)(bh·2^16 + bl) >> 16
 *     = ah·bh·2^16  +  ah·bl  +  al·bh  +  (al·bl >>> 16)
 * ```
 *
 * `al` and `bl` are taken as unsigned so `al·bl` stays below 2^32 and the
 * logical shift recovers its high half without sign contamination.
 */
export function fxMul(a: number, b: number): number {
  const ah = a >> FX_SHIFT;
  const al = a & 0xffff;
  const bh = b >> FX_SHIFT;
  const bl = b & 0xffff;

  return (
    ((Math.imul(ah, bh) << FX_SHIFT) +
      Math.imul(ah, bl) +
      Math.imul(al, bh) +
      (Math.imul(al, bl) >>> FX_SHIFT)) |
    0
  );
}

/**
 * 16.16 divide, truncating toward zero, wrapping on overflow.
 *
 * `a * FX_ONE` is at most 2^47, so it is an exact `Number`. Subtracting the
 * remainder before dividing makes the quotient exactly representable, which
 * means the division is exact rather than merely exactly-rounded — no reliance
 * on how a near-integer quotient rounds.
 *
 * Divide-by-zero saturates rather than producing `Infinity`/`NaN`: a `NaN` in
 * fixed-point state would poison the world hash and desync every client, which
 * is a far worse failure than a clamped value.
 */
export function fxDiv(a: number, b: number): number {
  if (b === 0) return a < 0 ? INT32_MIN : INT32_MAX;

  const scaled = a * FX_ONE;
  return ((scaled - (scaled % b)) / b) | 0;
}

/** Absolute value in 16.16. `fxAbs(INT32_MIN)` wraps to itself, as in any two's-complement machine. */
export function fxAbs(v: number): number {
  return v < 0 ? -v | 0 : v;
}

/** Constrain `v` to `[lo, hi]`. */
export function fxClamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * 16.16 square root, truncated. Negative input returns 0 rather than `NaN`, for
 * the same reason {@link fxDiv} saturates.
 *
 * `sqrt(V / 2^16) * 2^16 = sqrt(V * 2^16)`, so this is an integer square root
 * over a value up to 2^47 — computed bit by bit, with no division and no
 * `Math.sqrt` (which the spec permits an engine to approximate, and which
 * CLAUDE.md bans outright).
 */
export function fxSqrt(v: number): number {
  if (v <= 0) return 0;
  return isqrt(v * FX_ONE) | 0;
}

/**
 * Integer square root by the classic restoring shift-and-subtract method, for
 * `n` in `[0, 2^48)`. Every value stays an exact integer well under 2^53.
 */
function isqrt(n: number): number {
  let rem = n;
  let root = 0;
  // Largest power of four not exceeding the domain.
  let bit = 2 ** 46;

  while (bit > rem) bit /= 4;

  // `bit >= 1`, not `bit !== 0`. The integer form of this algorithm ends with
  // `bit >>= 2`, which takes 1 to 0; dividing a Number by 4 takes 1 to 0.25 and
  // never reaches zero, so the loop would run on through fractional "bits" and
  // halve `root` away to nothing. Caught by fxSqrt(2) returning 0.
  while (bit >= 1) {
    const trial = root + bit;
    root = Math.floor(root / 2);
    if (rem >= trial) {
      rem -= trial;
      root += bit;
    }
    bit /= 4;
  }

  return root;
}

// ---------------------------------------------------------------------------
// Trigonometry
// ---------------------------------------------------------------------------

/**
 * `sin` for one quadrant, in 16.16, indexed by angle in turn units.
 * `SIN_QUADRANT[i] = sin(i / TURN * 2pi)` for `i` in `[0, QUARTER_TURN]`.
 * The remaining three quadrants come from symmetry, so the table is 64 KB
 * rather than 256 KB and every lookup is exact — no interpolation.
 */
const SIN_QUADRANT: Int32Array = buildSinQuadrant();

/**
 * Build the quadrant table without ever calling `Math.sin`.
 *
 * The construction is a half-angle ladder followed by an angle-addition
 * recurrence, both exact:
 *
 * 1. Start at a right angle, where `cos = 0` and `sin = 1` are exact by
 *    definition — which is what lets this avoid `pi` entirely.
 * 2. Halve fourteen times via `cos(t/2) = sqrt((1 + cos t)/2)` and
 *    `sin(t/2) = sqrt((1 - cos t)/2)`, reaching exactly one turn unit
 *    (16384 → 1 is fourteen halvings).
 * 3. Walk the quadrant with `sin(a + d) = sin a·cos d + cos a·sin d` and
 *    `cos(a + d) = cos a·cos d - sin a·sin d`.
 *
 * `BigInt` at 2^40 is used rather than `Number`, because the recurrence
 * multiplies two scaled values and 2^40 · 2^40 overflows the exact-integer
 * range of a double. At that scale, 16384 accumulated roundings amount to
 * ~1e-8 — three orders of magnitude below 16.16's own 1.5e-5 resolution.
 *
 * This runs once per module instantiation (a few ms), never per tick. Workers
 * reuse an instantiated isolate across requests, so the replay validator pays
 * it once per isolate, not once per submission.
 */
function buildSinQuadrant(): Int32Array {
  const SHIFT = 64n;
  const ONE = 1n << SHIFT;
  const HALF = 1n << (SHIFT - 1n);

  // Step 1 & 2: from a right angle down to one turn unit.
  //
  // The sine uses `sin(t/2) = sin t / (2·cos(t/2))`, NOT the textbook
  // `sin(t/2) = sqrt((1 - cos t)/2)`. The textbook form subtracts two nearly
  // equal numbers: by the last rung cos(2d) is within 2e-8 of 1, so `ONE - cos`
  // throws away most of the significant digits and the resulting angle is wrong
  // by ~4e-5 relative. That error is invisible at the quadrant ends and peaks in
  // the middle — measured at 1.45 fx units before this was fixed, against 0.5
  // after. The form used here never subtracts near-equal values.
  let cos = 0n;
  let sin = ONE;
  for (let i = 0; i < 14; i += 1) {
    const nextCos = bigIsqrt(((ONE + cos) * ONE) / 2n);
    const nextSin = (sin * ONE + nextCos) / (2n * nextCos);
    cos = nextCos;
    sin = nextSin;
  }
  const stepCos = cos;
  const stepSin = sin;

  // Step 3: walk from 0 to a right angle, one unit at a time.
  const table = new Int32Array(QUARTER_TURN + 1);
  let s = 0n;
  let c = ONE;
  for (let k = 0; k <= QUARTER_TURN; k += 1) {
    table[k] = Number((s * BigInt(FX_ONE) + HALF) >> SHIFT);
    const nextS = (s * stepCos + c * stepSin + HALF) >> SHIFT;
    const nextC = (c * stepCos - s * stepSin + HALF) >> SHIFT;
    s = nextS;
    c = nextC;
  }

  // The axis values are exact by definition. Pinning them keeps sin(0) === 0
  // and cos(0) === FX_ONE rather than whatever the last rounding produced,
  // which matters because a car pointing straight down an axis is the most
  // common case in the game and the most obvious one to get wrong.
  table[0] = 0;
  table[QUARTER_TURN] = FX_ONE;

  return table;
}

/** Integer square root over `BigInt`, by Newton's method. Used only at module load. */
function bigIsqrt(n: bigint): bigint {
  if (n < 2n) return n;

  // Seed with 2^ceil(bits/2) so Newton converges in a handful of steps rather
  // than walking down from n.
  let x = 1n << (BigInt(n.toString(2).length + 1) >> 1n);
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

/**
 * `sin` of a `uint16` turn angle, in 16.16. Exact table lookup — no
 * interpolation, no approximation, identical in every engine.
 */
export function fxSin(angle: number): number {
  const a = angle & 0xffff;
  const index = a & (QUARTER_TURN - 1);

  // `| 0` on the negated branches normalises -0 to 0. Without it, sin of half a
  // turn returns -0, which compares equal to 0 but is a different bit pattern —
  // exactly the kind of thing that survives every test and then shows up as a
  // one-client-only hash mismatch.
  switch (a >> 14) {
    case 0:
      return SIN_QUADRANT[index];
    case 1:
      return SIN_QUADRANT[QUARTER_TURN - index];
    case 2:
      return -SIN_QUADRANT[index] | 0;
    default:
      return -SIN_QUADRANT[QUARTER_TURN - index] | 0;
  }
}

/** `cos` of a `uint16` turn angle, in 16.16. */
export function fxCos(angle: number): number {
  return fxSin(angle + QUARTER_TURN);
}

/**
 * Angle of the vector `(x, y)` as a `uint16` turn, measured from +X toward +Y.
 * `fxAtan2(0, 0)` is 0.
 *
 * Implemented as a binary search against {@link SIN_QUADRANT} rather than as a
 * second lookup table. Fourteen iterations land on the nearest representable
 * angle — the best answer the `uint16` encoding can express — and it reuses the
 * table already built, so there is one source of trigonometric truth rather
 * than two that could drift apart.
 *
 * `x` and `y` are compared via cross products of magnitude at most 2^47, which
 * is exact as a `Number`. They are used only for comparison, never stored, so
 * even `INT32_MIN` is handled without overflow.
 */
export function fxAtan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;

  const ax = Math.abs(x);
  const ay = Math.abs(y);

  // f(a) = sin(a)·ax - cos(a)·ay is non-decreasing across the first quadrant,
  // negative at 0 and non-negative at a right angle, so it brackets the answer.
  const f = (a: number): number => fxSin(a) * ax - fxCos(a) * ay;

  let lo = 0;
  let hi = QUARTER_TURN;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f(mid) <= 0) lo = mid;
    else hi = mid - 1;
  }

  // `lo` is the last angle at or below the target; the true angle lies between
  // `lo` and `lo + 1`. Pick whichever is nearer rather than always truncating.
  let quadrantAngle = lo;
  if (lo < QUARTER_TURN && Math.abs(f(lo + 1)) < Math.abs(f(lo))) {
    quadrantAngle = lo + 1;
  }

  if (x >= 0) {
    return (y >= 0 ? quadrantAngle : TURN - quadrantAngle) & 0xffff;
  }
  return (y >= 0 ? TURN / 2 - quadrantAngle : TURN / 2 + quadrantAngle) & 0xffff;
}
