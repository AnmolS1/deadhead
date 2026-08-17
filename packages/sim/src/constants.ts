/**
 * Simulation constants and the precision envelope everything else lives inside.
 *
 * Read the envelope section before adding a constant. Two of the numbers here
 * are not preferences — they fall out of int32 16.16 arithmetic, and violating
 * them corrupts state silently rather than throwing.
 */

/**
 * The simulation rate. Not a tuning knob: it is baked into every recorded input
 * log and every golden hash, so changing it invalidates the leaderboard and
 * needs an ADR.
 */
export const TICK_HZ = 30;

/**
 * Wall-clock length of one tick, in whole microseconds, for the client's
 * accumulator in `C-01`.
 *
 * **The sim never reads this.** It is truncated — 1e6/30 is 33_333.33… — and
 * the residual is why `C-01` budgets 1800 ± 2 ticks over 60 s rather than
 * exactly 1800. Scheduling only.
 */
export const TICK_INTERVAL_US = 33_333;

/**
 * There is deliberately **no** `FIXED_DT` in fixed-point form.
 *
 * 1/30 is not representable in 16.16: 65536/30 = 2184.53…, so a fixed-point dt
 * carries 0.024% error into every multiplication that uses it, every tick,
 * forever. Fixed-point error does not average out — it accumulates in one
 * direction — and two engines rounding the same expression differently is
 * exactly the determinism break that `S-14` exists to catch.
 *
 * So the sim never multiplies by dt. **Every rate is expressed in per-tick
 * units**: a velocity is units-per-tick, an acceleration is units-per-tick².
 * SI→per-tick conversion happens once, at authoring time, in the tuning tables
 * — never at runtime. `S-06`'s car constants follow this convention, and
 * `step()` takes no `dt` parameter (see CLAUDE.md hard invariant #2).
 */
export const SIM_VERSION = 0;

// ---------------------------------------------------------------------------
// Precision envelope — int32 16.16
// ---------------------------------------------------------------------------
//
// A raw int32 `D` encodes the value `d = D / 2^16`. Two separate bounds follow,
// and the tighter one is not the obvious one.
//
//   1. STORAGE BOUND — |d| < 32_768
//      The largest value an int32 can hold at scale 2^16. Any coordinate,
//      length or radius held in world state must stay inside this.
//
//   2. ARITHMETIC BOUND — |d| < 181
//      `fxMul(D, D)` produces raw `D^2 / 2^16 = d^2 * 2^16`, which must itself
//      fit in an int32:  d^2 * 2^16 < 2^31  →  d^2 < 2^15  →  |d| < 181.02.
//
//      This is a limit of the *representation*, not of any particular `fxMul`.
//      Computing the intermediate in 64 bits does not help, because the result
//      does not fit either.
//
//      Consequence, and the reason this comment is long: **a squared distance
//      may only ever be taken over a relative offset, never over absolute
//      coordinates.** S-07's narrowphase must work inside spatial-hash cells,
//      and S-09's despawn-on-distance and S-10's pickup radius must compare
//      offsets. Anything that genuinely needs to compare far-apart points must
//      drop to a coarser integer scale or compare Chebyshev/Manhattan distance
//      instead. Do not "fix" a violation by widening the type; there is no
//      wider type here.
//
// `S-03` implements the arithmetic and restates this in `fx.ts`.

/**
 * **Exclusive** bound on magnitude in 16.16. See STORAGE BOUND above.
 *
 * Note the name says `LIMIT`, not `MAX`, because 32_768 is *not* attainable:
 * `32_768 * 2^16` is exactly `2^31`, which overflows int32. The largest
 * representable positive value is one ULP below, 32_767.99998…. Compare with
 * `<`, never `<=`.
 */
export const FX_MAGNITUDE_LIMIT = 32_768;

/**
 * **Inclusive** bound on an operand that may be squared in 16.16 without
 * overflow — 181 itself is fine, 182 is not. See ARITHMETIC BOUND above.
 *
 * The asymmetry with {@link FX_MAGNITUDE_LIMIT} is deliberate and is why the
 * names differ: `MAX` is attainable, `LIMIT` is not. Always apply this to a
 * *relative offset*, never to an absolute coordinate.
 */
export const FX_MAX_SQUARABLE = 181;

/**
 * Half-width of the playable world, in whole units. The city occupies
 * `[-WORLD_HALF_EXTENT, +WORLD_HALF_EXTENT]` on both axes.
 *
 * Chosen well inside the storage bound rather than at it, because intermediate
 * values in collision and camera code routinely exceed the coordinates that
 * produced them. It is also far larger than `W-03` should need — that task
 * targets a 25–40 s full crossing and is explicitly told to resist making the
 * city big.
 *
 * Note this is ~11x the arithmetic bound, which is the point of the warning
 * above: a position is representable but not squarable.
 */
export const WORLD_HALF_EXTENT = 2048;

/** Inclusive lower bound of the world on both axes, in whole units. */
export const WORLD_MIN = -WORLD_HALF_EXTENT;

/** Inclusive upper bound of the world on both axes, in whole units. */
export const WORLD_MAX = WORLD_HALF_EXTENT;
