import { CarTuning, FareTuning } from '@deadhead/sim';
import { afterEach, describe, expect, it } from 'vitest';

import { applyPlaytestTuning, tuningBanner } from '../src/debug/playtest-tuning.js';

/**
 * The tuning harness. These matter more than they look: a harness that
 * misreports what it did produces a playtest result attributed to the wrong
 * numbers, which is worse than no result.
 */
const stock = {
  maxSpeed: CarTuning.maxSpeed,
  steerRate: CarTuning.steerRate,
  pickupRadius: FareTuning.pickupRadius,
  stoppedSpeed: FareTuning.stoppedSpeed,
  maxFareUnits: FareTuning.maxFareUnits,
};

afterEach(() => {
  Object.assign(CarTuning, { maxSpeed: stock.maxSpeed, steerRate: stock.steerRate });
  Object.assign(FareTuning, {
    pickupRadius: stock.pickupRadius,
    stoppedSpeed: stock.stoppedSpeed,
    maxFareUnits: stock.maxFareUnits,
  });
  applyPlaytestTuning('');
});

describe('a stock build', () => {
  it('changes nothing and shows no banner', () => {
    applyPlaytestTuning('');
    expect(tuningBanner()).toBeNull();
    expect(CarTuning.maxSpeed).toBe(stock.maxSpeed);
    expect(FareTuning.maxFareUnits).toBe(stock.maxFareUnits);
  });

  it('ignores an unrelated query string', () => {
    applyPlaytestTuning('?scale=5&city=none');
    expect(tuningBanner()).toBeNull();
    expect(CarTuning.maxSpeed).toBe(stock.maxSpeed);
  });
});

describe('an altered build always announces itself', () => {
  it('produces a banner whenever ANY dial moves', () => {
    // The guarantee the whole harness rests on. A tester playing modified
    // physics without knowing it is worse than no test.
    for (const query of ['?speed=1.2', '?steer=1.3', '?pickup=4.5', '?stop=8', '?fare=600']) {
      applyPlaytestTuning(query);
      expect(tuningBanner(), query).not.toBeNull();
    }
  });

  it('names every dial that moved', () => {
    applyPlaytestTuning('?speed=1.2&pickup=4.5');
    const banner = tuningBanner() ?? '';
    expect(banner).toContain('speed');
    expect(banner).toContain('pickup');
  });
});

describe('multipliers', () => {
  it('scale from the STOCK value, not the current one', () => {
    // Applying twice must not compound. Reading the live value would make a
    // second call to ?speed=1.2 silently give 1.44x while the banner still
    // said 1.20x — a measurement lying about itself.
    applyPlaytestTuning('?speed=1.2');
    const once = CarTuning.maxSpeed;
    applyPlaytestTuning('?speed=1.2');
    expect(CarTuning.maxSpeed).toBe(once);
  });

  it('restores the stock value when the dial is dropped', () => {
    applyPlaytestTuning('?speed=1.5');
    expect(CarTuning.maxSpeed).not.toBe(stock.maxSpeed);
    // A dial absent from the URL must go back, or a session inherits the last
    // one's physics and nobody can tell which numbers produced which feedback.
    applyPlaytestTuning('?speed=1');
    expect(CarTuning.maxSpeed).toBe(stock.maxSpeed);
  });
});

describe('bad input costs the dial, not the session', () => {
  it('ignores unparseable and negative values', () => {
    for (const query of ['?speed=abc', '?speed=-1', '?speed=', '?pickup=NaN']) {
      applyPlaytestTuning(query);
      expect(CarTuning.maxSpeed, query).toBe(stock.maxSpeed);
      expect(tuningBanner(), query).toBeNull();
    }
  });
});

describe('the fare cap', () => {
  it('sets whole world units and reports the rough seconds', () => {
    applyPlaytestTuning('?fare=600');
    expect(FareTuning.maxFareUnits).toBe(600);
    expect(tuningBanner() ?? '').toContain('20s');
  });
});
