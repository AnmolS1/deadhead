import { describe, expect, it } from 'vitest';

import { SIM_VERSION } from '../src/constants.js';
import { createWorld, step } from '../src/step.js';
import type { Inputs } from '../src/types.js';

const NO_INPUT: Inputs = [0, 0];

describe('createWorld', () => {
  it('starts a run at tick 0', () => {
    expect(createWorld().tick).toBe(0);
  });

  it('stamps the state format version', () => {
    expect(createWorld().version).toBe(SIM_VERSION);
  });
});

describe('step', () => {
  it('advances by exactly one tick', () => {
    expect(step(createWorld(), NO_INPUT).tick).toBe(1);
  });

  it('does not mutate the world it was given', () => {
    // Prediction in M-06 replays inputs over a retained past state. If step()
    // ever mutates its argument, reconciliation corrupts the history it is
    // replaying from, and the bug surfaces as unexplained net desync rather
    // than as anything that looks like aliasing.
    const before = createWorld();
    const snapshot = structuredClone(before);

    step(before, NO_INPUT);

    expect(before).toEqual(snapshot);
  });

  it('is a pure function of its arguments', () => {
    const world = createWorld();
    expect(step(world, NO_INPUT)).toEqual(step(world, NO_INPUT));
  });

  it('produces identical state over a long run from identical starts', () => {
    // The determinism property in miniature. S-14 does this properly, across
    // engines and with hashes; this version exists so a regression in the
    // stepping contract fails here first, in milliseconds.
    const run = (ticks: number) => {
      let world = createWorld();
      for (let i = 0; i < ticks; i += 1) world = step(world, NO_INPUT);
      return world;
    };

    expect(run(10_000)).toEqual(run(10_000));
    expect(run(10_000).tick).toBe(10_000);
  });
});
