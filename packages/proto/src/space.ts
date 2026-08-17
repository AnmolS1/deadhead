/**
 * `space.ts` — the shared coordinate system.
 *
 * These constants define the space that the sim, the city format and the wire
 * format all agree on. They live in `@deadhead/proto` rather than in the sim
 * because **more than one package has to be right about them**: `W-01` validates
 * city coordinates against the envelope, `M-04` quantises positions into
 * snapshots, and `packages/sim` does the arithmetic. Two copies of these numbers
 * that drift apart is precisely how a replay validator ends up disagreeing with
 * a client.
 *
 * The arithmetic itself stays in `packages/sim/src/fx.ts`; only the numbers are
 * here. See ADR 0003 for why the scale is what it is.
 */

/** Fractional bits in the fixed-point representation. Raw `D` encodes `d = D / 2^FX_SHIFT`. */
export const FX_SHIFT = 16;

/** 1.0 in 16.16. */
export const FX_ONE = 1 << FX_SHIFT;

/** 0.5 in 16.16. */
export const FX_HALF = FX_ONE >> 1;

/**
 * **Exclusive** bound on magnitude in 16.16.
 *
 * `LIMIT`, not `MAX`, because 32_768 is not attainable: `32_768 * 2^16` is
 * exactly `2^31`, which overflows int32. Compare with `<`, never `<=`.
 */
export const FX_MAGNITUDE_LIMIT = 32_768;

/**
 * **Inclusive** bound on an operand that may be squared in 16.16 — 181 is fine,
 * 182 is not.
 *
 * `fxMul(D, D)` produces raw `d² · 2^16`, which must itself fit in an int32, so
 * `d² < 2^15`. This is a limit of the *representation*: a 64-bit intermediate
 * does not help, because the result does not fit either.
 *
 * The consequence, which `S-07`, `S-09` and `S-10` all depend on: **a squared
 * distance may only be taken over a relative offset, never over absolute
 * coordinates.** The asymmetry with {@link FX_MAGNITUDE_LIMIT} is why the names
 * differ — `MAX` is attainable, `LIMIT` is not.
 */
export const FX_MAX_SQUARABLE = 181;

/**
 * Half-width of the playable world, in whole units. A city occupies
 * `[-WORLD_HALF_EXTENT, +WORLD_HALF_EXTENT]` on both axes.
 *
 * Chosen well inside the storage bound rather than at it, because intermediate
 * values in collision and camera code routinely exceed the coordinates that
 * produced them. Note it is ~11x the *arithmetic* bound, which is the point of
 * the warning above: a position is representable but not squarable.
 */
export const WORLD_HALF_EXTENT = 2048;

/** Inclusive lower bound of the world on both axes, in whole units. */
export const WORLD_MIN = -WORLD_HALF_EXTENT;

/** Inclusive upper bound of the world on both axes, in whole units. */
export const WORLD_MAX = WORLD_HALF_EXTENT;

/**
 * Angle units in one revolution. Angles are a `uint16` **turn**, so wrapping is
 * a free `& 0xffff` and is exact. There are no radians anywhere in the sim and
 * no `Math.PI`.
 */
export const TURN = 65536;

/** A right angle, exactly. */
export const QUARTER_TURN = TURN >> 2;
