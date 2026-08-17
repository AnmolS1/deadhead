import { describe, expect, it } from 'vitest';

import {
  RNG_LANES,
  rngCreate,
  rngIsDegenerate,
  rngNextBelow,
  rngNextRange,
  rngNextU32,
  rngPick,
  rngPickIndex,
  rngSeed,
} from '../src/rng.js';
import fixture from './fixtures/xorshift128plus.json' with { type: 'json' };

/**
 * The reference implementation, in exact 64-bit `BigInt`. This is the oracle:
 * `packages/sim/src/rng.ts` is checked against *this*, and the committed fixture
 * was generated from this rather than from the implementation — otherwise the
 * fixture would only ever re-record whatever the lanes happened to do.
 */
const MASK64 = (1n << 64n) - 1n;

function refNext(state: [bigint, bigint]): { result: bigint; state: [bigint, bigint] } {
  let s1 = state[0];
  const s0 = state[1];
  const result = (s0 + s1) & MASK64;
  s1 = (s1 ^ (s1 << 23n)) & MASK64;
  return { result, state: [s0, (s1 ^ s0 ^ (s1 >> 17n) ^ (s0 >> 26n)) & MASK64] };
}

const wordsOf = (rng: Int32Array): [bigint, bigint] => [
  (BigInt(rng[1] >>> 0) << 32n) | BigInt(rng[0] >>> 0),
  (BigInt(rng[3] >>> 0) << 32n) | BigInt(rng[2] >>> 0),
];

// ---------------------------------------------------------------------------

describe('seeding', () => {
  it('produces the documented number of lanes', () => {
    expect(rngCreate(1)).toHaveLength(RNG_LANES);
  });

  it('never produces the all-zero fixed point, including from seed 0', () => {
    // The all-zero state emits zero forever and does so perfectly
    // deterministically, so nothing downstream would flag it. Seed 0 is the
    // specific hazard: murmur3's finaliser maps 0 to 0, which is why the
    // splitmix32 step increments before mixing.
    for (const seed of [0, 1, -1, 0x7fffffff, -0x80000000, 12345]) {
      const rng = rngCreate(seed);
      expect(rngIsDegenerate(rng)).toBe(false);
      expect(rng[0]).not.toBe(0);
    }
  });

  it('gives different seeds different streams', () => {
    const a = rngCreate(1);
    const b = rngCreate(2);
    expect(rngNextU32(a)).not.toBe(rngNextU32(b));
  });

  it('gives the same seed the same stream', () => {
    const a = rngCreate(0xabcdef);
    const b = rngCreate(0xabcdef);
    for (let i = 0; i < 100; i += 1) {
      expect(rngNextU32(a)).toBe(rngNextU32(b));
    }
  });

  it('seeds in place, so it can target a view into the world buffer', () => {
    // S-05 stores the generator inside the world's single backing Int32Array.
    const world = new Int32Array(32);
    const view = world.subarray(8, 8 + RNG_LANES);

    rngSeed(view, 99);

    expect(Array.from(view)).toEqual(Array.from(rngCreate(99)));
    // Writing through the view must reach the buffer, not a copy.
    expect(world[8]).toBe(view[0]);
    expect(world[7]).toBe(0);
    expect(world[12]).toBe(0);
  });
});

describe('agreement with the 64-bit reference', () => {
  it('matches BigInt xorshift128+ over 100k draws, in both halves', () => {
    // The strongest check available: every 64-bit shift, xor and carry in the
    // hand-assembled int32 version is compared against exact arithmetic.
    const rng = rngCreate(0x51ed_6a7e);
    let state = wordsOf(rng);

    for (let i = 0; i < 100_000; i += 1) {
      const step = refNext(state);
      state = step.state;

      const got = rngNextU32(rng);
      expect(got).toBe(Number(step.result >> 32n));
      // The low half is not returned, but the lanes must still carry it, or the
      // next draw diverges.
      expect(wordsOf(rng)).toEqual(state);
    }
  });
});

describe('the committed fixture', () => {
  it('reproduces 1000 values from the recorded seed', () => {
    // GOLDEN. Generated from the BigInt reference. If this fails, the generator
    // changed — do not regenerate the fixture to make it pass. Every recorded
    // replay and every leaderboard entry depends on this stream.
    const rng = rngCreate(fixture.seed);
    expect(Array.from(rng)).toEqual(fixture.initialLanes);

    for (let i = 0; i < fixture.values.length; i += 1) {
      const expected = BigInt(`0x${fixture.values[i]}`);
      expect(rngNextU32(rng)).toBe(Number(expected >> 32n));
    }
  });

  it('records a full thousand values', () => {
    expect(fixture.values).toHaveLength(1000);
  });
});

describe('state round-trips', () => {
  it('continues identically after a copy', () => {
    // The property S-05's serialize/deserialize inherits, and the reason the
    // generator state lives in the world rather than beside it.
    const original = rngCreate(0xfeed);
    for (let i = 0; i < 500; i += 1) rngNextU32(original);

    const restored = new Int32Array(original);

    for (let i = 0; i < 500; i += 1) {
      expect(rngNextU32(restored)).toBe(rngNextU32(original));
    }
  });

  it('a resumed stream differs from a restarted one', () => {
    // Guards against the copy accidentally re-seeding: if this passed by
    // returning to the start, the round-trip test above would pass too.
    const advanced = rngCreate(7);
    for (let i = 0; i < 100; i += 1) rngNextU32(advanced);

    expect(rngNextU32(new Int32Array(advanced))).not.toBe(rngNextU32(rngCreate(7)));
  });
});

describe('output shape', () => {
  it('always returns an exact integer in [0, 2^32)', () => {
    const rng = rngCreate(0x1234);
    for (let i = 0; i < 100_000; i += 1) {
      const v = rngNextU32(rng);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(0x1_0000_0000);
    }
  });

  it('does not get stuck or fall into a short cycle', () => {
    const rng = rngCreate(3);
    const seen = new Set<number>();
    for (let i = 0; i < 50_000; i += 1) seen.add(rngNextU32(rng));
    // Birthday collisions in 50k draws from 2^32 are expected to be ~0.3.
    expect(seen.size).toBeGreaterThan(49_990);
  });
});

describe('bounded draws', () => {
  it('stays inside the bound', () => {
    const rng = rngCreate(11);
    for (const bound of [1, 2, 3, 7, 12, 64, 1000, 65_537]) {
      for (let i = 0; i < 2_000; i += 1) {
        const v = rngNextBelow(rng, bound);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(bound);
      }
    }
  });

  it('degenerate bounds return 0 rather than NaN', () => {
    const rng = rngCreate(11);
    expect(rngNextBelow(rng, 1)).toBe(0);
    expect(rngNextBelow(rng, 0)).toBe(0);
    expect(rngNextBelow(rng, -5)).toBe(0);
  });

  it('is unbiased across a bound that does not divide 2^32', () => {
    // 3 is the classic modulo-bias case: naive `u32 % 3` over-represents 0 and
    // 1. Rejection sampling is why this passes.
    const rng = rngCreate(0xb1a5);
    const counts = [0, 0, 0];
    const draws = 300_000;
    for (let i = 0; i < draws; i += 1) counts[rngNextBelow(rng, 3)] += 1;

    for (const count of counts) {
      const skew = Math.abs(count - draws / 3) / (draws / 3);
      expect(skew).toBeLessThan(0.01);
    }
  });

  it('rejection sampling consumes a deterministic number of draws', () => {
    // The redraw count varies with the stream, which is fine; what matters is
    // that it varies identically everywhere.
    const a = rngCreate(0xc0ffee);
    const b = rngCreate(0xc0ffee);
    for (let i = 0; i < 10_000; i += 1) expect(rngNextBelow(a, 3)).toBe(rngNextBelow(b, 3));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('rngNextRange covers its interval and respects negatives', () => {
    const rng = rngCreate(5);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i += 1) {
      const v = rngNextRange(rng, -10, 10);
      expect(v).toBeGreaterThanOrEqual(-10);
      expect(v).toBeLessThan(10);
      seen.add(v);
    }
    expect(seen.size).toBe(20);
    expect(rngNextRange(rng, 4, 4)).toBe(4);
  });
});

describe('picking', () => {
  it('rngPickIndex stays in range and reports emptiness', () => {
    const rng = rngCreate(13);
    expect(rngPickIndex(rng, 0)).toBe(-1);
    for (let i = 0; i < 1_000; i += 1) {
      const index = rngPickIndex(rng, 5);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(5);
    }
  });

  it('rngPick returns an element, or undefined for an empty array', () => {
    const rng = rngCreate(13);
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 100; i += 1) {
      expect(items).toContain(rngPick(rng, items));
    }
    expect(rngPick(rng, [])).toBeUndefined();
  });
});

describe('rngIsDegenerate', () => {
  it('detects the all-zero fixed point', () => {
    expect(rngIsDegenerate(new Int32Array(RNG_LANES))).toBe(true);
    expect(rngIsDegenerate(rngCreate(1))).toBe(false);

    const almost = new Int32Array(RNG_LANES);
    almost[3] = 1;
    expect(rngIsDegenerate(almost)).toBe(false);
  });

  it('confirms the fixed point really is absorbing', () => {
    // Why this check exists at all: the degenerate state is perfectly
    // deterministic, so a replay seeded with it would validate cleanly while
    // producing a constant world.
    const stuck = new Int32Array(RNG_LANES);
    for (let i = 0; i < 100; i += 1) expect(rngNextU32(stuck)).toBe(0);
  });
});
