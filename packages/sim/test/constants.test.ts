import { describe, expect, it } from 'vitest';

import {
  FX_MAX_MAGNITUDE,
  FX_MAX_SQUARABLE,
  TICK_HZ,
  TICK_INTERVAL_US,
  WORLD_HALF_EXTENT,
  WORLD_MAX,
  WORLD_MIN,
} from '../src/constants.js';

/**
 * These tests *derive* the precision envelope rather than restating the
 * numbers, so they fail if someone widens a bound without doing the
 * arithmetic. Restating `expect(FX_MAX_SQUARABLE).toBe(181)` would pass
 * whatever the constant said, which is worth nothing.
 */

const FX_SHIFT = 16;
const FX_ONE = 2 ** FX_SHIFT;
/** Exclusive upper bound of a positive int32. */
const INT32_LIMIT = 2 ** 31;

describe('16.16 precision envelope', () => {
  it('FX_MAX_MAGNITUDE is the largest value representable at scale 2^16', () => {
    expect(FX_MAX_MAGNITUDE * FX_ONE).toBe(INT32_LIMIT);
  });

  it('FX_MAX_SQUARABLE is the largest operand whose square survives fxMul', () => {
    // fxMul(D, D) yields raw d^2 * 2^16, which must fit in an int32.
    const rawSquare = (d: number): number => d * d * FX_ONE;

    expect(rawSquare(FX_MAX_SQUARABLE)).toBeLessThan(INT32_LIMIT);
    expect(rawSquare(FX_MAX_SQUARABLE + 1)).toBeGreaterThanOrEqual(INT32_LIMIT);
  });

  it('the arithmetic bound is far tighter than the storage bound', () => {
    // The whole point of the warning in constants.ts. If these ever converge,
    // something has changed about the scale and S-07 needs re-reading.
    expect(FX_MAX_SQUARABLE).toBeLessThan(FX_MAX_MAGNITUDE);
  });
});

describe('world bounds', () => {
  it('fits inside the storage bound with room for intermediates', () => {
    expect(WORLD_HALF_EXTENT).toBeLessThan(FX_MAX_MAGNITUDE);
    expect(WORLD_HALF_EXTENT * FX_ONE).toBeLessThan(INT32_LIMIT);
  });

  it('is symmetric about the origin', () => {
    expect(WORLD_MIN).toBe(-WORLD_HALF_EXTENT);
    expect(WORLD_MAX).toBe(WORLD_HALF_EXTENT);
  });

  it('exceeds the arithmetic bound, so positions are not squarable', () => {
    // Documented deliberately rather than treated as a defect: it is why a
    // squared distance must be taken over a relative offset. If this ever
    // stops being true the guidance in constants.ts and S-07 changes.
    expect(WORLD_HALF_EXTENT).toBeGreaterThan(FX_MAX_SQUARABLE);
  });
});

describe('tick rate', () => {
  it('is an integer rate', () => {
    expect(Number.isInteger(TICK_HZ)).toBe(true);
    expect(TICK_HZ).toBe(30);
  });

  it('has a whole-microsecond interval that under-counts by less than a tick', () => {
    expect(Number.isInteger(TICK_INTERVAL_US)).toBe(true);
    expect(TICK_INTERVAL_US).toBe(Math.floor(1_000_000 / TICK_HZ));

    // The truncation is why C-01 budgets 1800 +/- 2 ticks over 60 s rather
    // than exactly 1800. Pin the drift so the tolerance stays justified.
    const driftPerMinuteTicks = 60 * TICK_HZ - 60_000_000 / TICK_INTERVAL_US;
    expect(Math.abs(driftPerMinuteTicks)).toBeLessThan(1);
  });
});
