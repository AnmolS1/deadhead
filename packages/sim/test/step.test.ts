import { describe, expect, it } from 'vitest';

import { WORLD_INT32S, cloneWorld, createWorld, getTick, hashWorld } from '../src/world.js';
import { step } from '../src/step.js';
import type { Inputs } from '../src/types.js';

/**
 * The `step()` contract. `world.test.ts` owns the state layout and its
 * serialisation; this file owns the three properties everything downstream
 * assumes about the step function itself — purity, immutability, and
 * reproducibility over a long run.
 */

const NO_INPUT: Inputs = [0, 0];

/** Full-buffer equality. Stronger than comparing hashes, which could collide. */
const bytesOf = (world: { data: Int32Array }): number[] => Array.from(world.data);

describe('step is pure', () => {
  it('returns the same world for the same arguments', () => {
    const world = createWorld(1, 2);
    expect(bytesOf(step(world, NO_INPUT))).toEqual(bytesOf(step(world, NO_INPUT)));
  });

  it('depends on nothing outside its arguments', () => {
    // Two worlds built identically at different moments must step identically.
    // If step ever reached for wall-clock time or unseeded randomness, this is
    // where it would show — and `lint:sim-purity` would have caught it first.
    const a = step(createWorld(77, 3), [1, 2, 3]);
    const b = step(createWorld(77, 3), [1, 2, 3]);
    expect(bytesOf(a)).toEqual(bytesOf(b));
  });
});

describe('step does not mutate the world it was given', () => {
  it('leaves every slot of the argument untouched', () => {
    // The single most important assertion in this file. M-06 reconciliation
    // replays inputs over a *retained past state*; if step mutates its
    // argument, it corrupts the history it is replaying from, and the bug
    // surfaces as unexplained net desync rather than as anything resembling
    // aliasing. Compared slot by slot rather than by hash so a collision
    // cannot hide it.
    const world = createWorld(9, 4);
    const before = bytesOf(world);

    step(world, [0xff, 0xff, 0xff, 0xff]);

    expect(bytesOf(world)).toEqual(before);
  });

  it('returns a distinct buffer, not a reference to the same one', () => {
    const world = createWorld(9);
    const next = step(world, NO_INPUT);

    expect(next.data).not.toBe(world.data);
    expect(next.data.buffer).not.toBe(world.data.buffer);
  });

  it('holds across a long chain, so no tick aliases an earlier one', () => {
    const states = [createWorld(3, 2)];
    for (let i = 0; i < 200; i += 1) {
      states.push(step(states[states.length - 1] as (typeof states)[0], [i & 0xff, 0]));
    }

    // Every retained state still reports its own tick — which it would not if
    // any step had written through to an earlier buffer.
    for (let i = 0; i < states.length; i += 1) {
      expect(getTick(states[i] as (typeof states)[0])).toBe(i);
    }
  });
});

describe('step is reproducible', () => {
  it('advances by exactly one tick', () => {
    expect(getTick(step(createWorld(1), NO_INPUT))).toBe(1);
  });

  it('produces an identical world after 10,000 ticks', () => {
    // The determinism property in miniature. S-14 does this properly, across
    // engines and against recorded logs; this version exists so a regression in
    // the stepping contract fails here first, in milliseconds.
    const run = (): { hash: number; tick: number; bytes: number[] } => {
      let world = createWorld(0xd00d, 2);
      for (let i = 0; i < 10_000; i += 1) {
        world = step(world, [i & 0xff, (i >> 3) & 0xff]);
      }
      return { hash: hashWorld(world), tick: getTick(world), bytes: bytesOf(world) };
    };

    const first = run();
    const second = run();

    expect(first.tick).toBe(10_000);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.hash).toBe(first.hash);
  });

  it('a clone stepped alongside the original stays in lockstep', () => {
    // G-07's ghost racing, in one assertion: a second sim instance advancing
    // from the same state must never drift.
    let live = createWorld(0x9ace, 2);
    let ghost = cloneWorld(live);

    for (let i = 0; i < 1_000; i += 1) {
      const inputs = [i & 0xff, (i * 3) & 0xff];
      live = step(live, inputs);
      ghost = step(ghost, inputs);
      if (i % 250 === 0) expect(hashWorld(ghost)).toBe(hashWorld(live));
    }

    expect(bytesOf(ghost)).toEqual(bytesOf(live));
  });

  it('every world it produces is the documented size', () => {
    let world = createWorld(1);
    for (let i = 0; i < 50; i += 1) {
      world = step(world, NO_INPUT);
      expect(world.data).toHaveLength(WORLD_INT32S);
    }
  });
});
