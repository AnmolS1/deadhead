/**
 * `rng.ts` — xorshift128+, over `int32` lanes.
 *
 * The generator's state lives *inside the world*, so it is snapshotted,
 * serialised and hashed along with everything else. A resumed sim continues the
 * identical stream; a replay validator re-running the same log draws the same
 * numbers in the same order. That is the whole reason this exists instead of
 * `Math.random()`, which is banned outright (see `eslint.purity.mjs`).
 *
 * ## Why the state is an `Int32Array`
 *
 * xorshift128+ is defined over two 64-bit words. JavaScript has no `int64`, and
 * `BigInt` in a 30 Hz hot loop is not an option, so each word is carried as a
 * `(lo, hi)` pair of `int32` lanes and every 64-bit shift, xor and add is
 * assembled by hand below. `Number` appears only where it holds an exact
 * integer — the carry in the 64-bit add reaches 2^33, which is far under 2^53.
 *
 * Laying the state out as an `Int32Array` also means it can be a *view* into the
 * world's single backing buffer (`S-05`), so seeding, copying and serialising
 * the RNG are all just part of copying the world.
 *
 * ## Output word
 *
 * {@link rngNextU32} returns the **high** 32 bits of the 64-bit result. The low
 * bits of xorshift128+ are the weak end — the lowest bit in particular fails
 * linearity tests — and taking the high word costs nothing. The full 64-bit
 * output is still pinned by the committed fixture, so the choice of half is a
 * separable decision rather than something baked into the test data.
 */

/** Lanes of `int32` making up the generator state: `[word0.lo, word0.hi, word1.lo, word1.hi]`. */
export const RNG_LANES = 4;

/**
 * Generator state. Exactly {@link RNG_LANES} `int32`s, and usually a subarray
 * view into the world buffer rather than a standalone allocation.
 */
export type RngState = Int32Array;

/** 2^32, as an exact `Number`. Used for unbiased bounding. */
const TWO_32 = 0x1_0000_0000;

/**
 * Advance a splitmix32 state and mix it. The increment happens *before* the
 * mix, which is what stops seed 0 from producing a zero lane — murmur3's
 * finaliser maps 0 to 0, and 0 is the seed people actually type.
 */
function splitmix32(state: number): number {
  let z = (state + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) | 0;
}

/**
 * Fill `rng` from a 32-bit seed. Writes in place so it can seed a view into the
 * world buffer.
 *
 * The all-zero state is xorshift's fixed point: it produces zero forever, and
 * it does so perfectly deterministically, so nothing downstream would flag it.
 * The expansion below cannot produce it, and {@link rngIsDegenerate} catches it
 * on the way back in from a deserialised replay.
 */
export function rngSeed(rng: RngState, seed: number): void {
  let state = seed | 0;
  for (let lane = 0; lane < RNG_LANES; lane += 1) {
    state = splitmix32(state);
    rng[lane] = state;
  }

  if (rngIsDegenerate(rng)) rng[0] = 1;
}

/** Allocate and seed a standalone generator. */
export function rngCreate(seed: number): RngState {
  const rng = new Int32Array(RNG_LANES);
  rngSeed(rng, seed);
  return rng;
}

/**
 * True if the state is the all-zero fixed point, from which the generator emits
 * zero forever. Only reachable by deserialising hostile or corrupt bytes;
 * `S-05`'s `deserialize` rejects it rather than trusting the input.
 */
export function rngIsDegenerate(rng: RngState): boolean {
  for (let lane = 0; lane < RNG_LANES; lane += 1) {
    if (rng[lane] !== 0) return false;
  }
  return true;
}

/**
 * Draw the next value, advancing the state in place. Returns the high 32 bits
 * of the 64-bit output, as an exact integer in `[0, 2^32)`.
 *
 * This is xorshift128+ transcribed directly:
 *
 * ```text
 *   s1 = s[0];  s0 = s[1];
 *   result = s0 + s1;
 *   s[0] = s0;
 *   s1 ^= s1 << 23;
 *   s[1] = s1 ^ s0 ^ (s1 >> 17) ^ (s0 >> 26);
 * ```
 */
export function rngNextU32(rng: RngState): number {
  let s1lo = rng[0];
  let s1hi = rng[1];
  const s0lo = rng[2];
  const s0hi = rng[3];

  // result = s0 + s1, 64-bit. The low halves are added as unsigned Numbers so
  // the carry is visible; the sum tops out at 2^33 - 2, exact in a double.
  const sumLo = (s0lo >>> 0) + (s1lo >>> 0);
  const resultHi = (s0hi + s1hi + (sumLo >= TWO_32 ? 1 : 0)) | 0;

  rng[0] = s0lo;
  rng[1] = s0hi;

  // s1 ^= s1 << 23
  const shiftedHi = (s1hi << 23) | (s1lo >>> 9) | 0;
  const shiftedLo = (s1lo << 23) | 0;
  s1lo = (s1lo ^ shiftedLo) | 0;
  s1hi = (s1hi ^ shiftedHi) | 0;

  // s1 >> 17 and s0 >> 26, both logical over the 64-bit pair.
  const r17lo = (s1lo >>> 17) | (s1hi << 15) | 0;
  const r17hi = s1hi >>> 17;
  const r26lo = (s0lo >>> 26) | (s0hi << 6) | 0;
  const r26hi = s0hi >>> 26;

  rng[2] = (s1lo ^ s0lo ^ r17lo ^ r26lo) | 0;
  rng[3] = (s1hi ^ s0hi ^ r17hi ^ r26hi) | 0;

  return resultHi >>> 0;
}

/**
 * Uniform integer in `[0, bound)`, with no modulo bias.
 *
 * Values in the short final block above the largest multiple of `bound` are
 * rejected and redrawn. The number of draws therefore varies — but it varies
 * *identically* on every machine, because it depends only on the stream, so
 * determinism is unaffected.
 */
export function rngNextBelow(rng: RngState, bound: number): number {
  if (bound <= 1) return 0;

  const limit = TWO_32 - (TWO_32 % bound);
  let value = rngNextU32(rng);
  while (value >= limit) value = rngNextU32(rng);

  return value % bound;
}

/** Uniform integer in `[lo, hi)`. Returns `lo` if the range is empty. */
export function rngNextRange(rng: RngState, lo: number, hi: number): number {
  return (lo + rngNextBelow(rng, hi - lo)) | 0;
}

/** Uniform index into a collection of `length` items, or -1 if there are none. */
export function rngPickIndex(rng: RngState, length: number): number {
  if (length <= 0) return -1;
  return rngNextBelow(rng, length);
}

/**
 * Uniform element of a non-empty array. Prefer {@link rngPickIndex} in the sim
 * itself — the state is index-based, and an index is an `int32`.
 */
export function rngPick<T>(rng: RngState, items: readonly T[]): T | undefined {
  const index = rngPickIndex(rng, items.length);
  return index < 0 ? undefined : items[index];
}
