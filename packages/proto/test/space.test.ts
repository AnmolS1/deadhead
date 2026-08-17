import { describe, expect, it } from 'vitest';

import {
  FX_HALF,
  FX_MAGNITUDE_LIMIT,
  FX_MAX_SQUARABLE,
  FX_ONE,
  FX_SHIFT,
  QUARTER_TURN,
  TURN,
  WORLD_HALF_EXTENT,
  WORLD_MAX,
  WORLD_MIN,
} from '../src/space.js';

/**
 * These tests **derive** the precision envelope rather than restating the
 * numbers, so they fail if someone widens a bound without doing the arithmetic.
 * `expect(FX_MAX_SQUARABLE).toBe(181)` would pass whatever the constant said,
 * which is worth nothing.
 *
 * They live here, beside the source of truth, rather than in `packages/sim`
 * which only re-exports these.
 */

/** Exclusive upper bound of a positive int32. */
const INT32_LIMIT = 2 ** 31;

describe('the 16.16 scale', () => {
  it('is internally consistent', () => {
    expect(FX_ONE).toBe(2 ** FX_SHIFT);
    expect(FX_HALF).toBe(FX_ONE / 2);
    expect(Number.isInteger(FX_HALF)).toBe(true);
  });
});

describe('the precision envelope', () => {
  it('FX_MAGNITUDE_LIMIT is exclusive — the limit itself does not fit', () => {
    expect(FX_MAGNITUDE_LIMIT * FX_ONE).toBe(INT32_LIMIT);
    expect((FX_MAGNITUDE_LIMIT - 1) * FX_ONE).toBeLessThan(INT32_LIMIT);
  });

  it('FX_MAX_SQUARABLE is the largest operand whose square survives fxMul', () => {
    // fxMul(D, D) yields raw d^2 * 2^16, which must fit in an int32.
    const rawSquare = (d: number): number => d * d * FX_ONE;
    expect(rawSquare(FX_MAX_SQUARABLE)).toBeLessThan(INT32_LIMIT);
    expect(rawSquare(FX_MAX_SQUARABLE + 1)).toBeGreaterThanOrEqual(INT32_LIMIT);
  });

  it('keeps the arithmetic bound far tighter than the storage bound', () => {
    expect(FX_MAX_SQUARABLE).toBeLessThan(FX_MAGNITUDE_LIMIT);
  });
});

describe('world bounds', () => {
  it('fit inside the storage bound with room for intermediates', () => {
    expect(WORLD_HALF_EXTENT).toBeLessThan(FX_MAGNITUDE_LIMIT);
    expect(WORLD_HALF_EXTENT * FX_ONE).toBeLessThan(INT32_LIMIT);
  });

  it('are symmetric about the origin', () => {
    expect(WORLD_MIN).toBe(-WORLD_HALF_EXTENT);
    expect(WORLD_MAX).toBe(WORLD_HALF_EXTENT);
  });

  it('exceed the arithmetic bound, so positions are not squarable', () => {
    // Documented deliberately rather than treated as a defect: it is why a
    // squared distance must be taken over a relative offset. W-01 validates
    // city coordinates against these, S-07's broadphase depends on it.
    expect(WORLD_HALF_EXTENT).toBeGreaterThan(FX_MAX_SQUARABLE);
  });
});

describe('angles', () => {
  it('divide a revolution exactly into uint16 units', () => {
    expect(TURN).toBe(0x1_0000);
    expect(QUARTER_TURN).toBe(TURN / 4);
    expect(Number.isInteger(QUARTER_TURN)).toBe(true);
    // Wrapping is a mask, which is only exact because TURN is a power of two.
    expect((TURN * 7 + 123) & (TURN - 1)).toBe(123);
  });
});
