/**
 * `step()` — the only entry point into the simulation.
 *
 * Skeleton (`S-01`). It advances the tick counter, which is the one thing every
 * future version of this function will also do. `S-06` onward attach the car
 * model, collision, traffic, passengers, fares and clocks to it, in that order.
 */
import { SIM_VERSION } from './constants.js';
import type { Inputs, World } from './types.js';

/**
 * Advance the world by exactly one tick.
 *
 * Pure: a function of its arguments and nothing else. Same `(world, inputs)`
 * must produce the same output in the browser, in a Durable Object, and in the
 * replay validator — byte for byte, in every engine. That guarantee is what
 * `S-14` gates on, and it is why this signature has **no `dt` parameter**: the
 * timestep is `TICK_HZ`, a compile-time constant, and rates are expressed in
 * per-tick units rather than multiplied by a fixed-point dt that cannot
 * represent 1/30 exactly. See `constants.ts` and CLAUDE.md hard invariant #2.
 *
 * @param world  State at tick `t`. Treated as immutable.
 * @param inputs One packed input byte per player, dense, for tick `t`.
 * @returns State at tick `t + 1`.
 */
export function step(world: World, _inputs: Inputs): World {
  // `_inputs` is unread until S-06 lands the car model. The parameter exists
  // now so every caller built during Phase 1 is already passing it.
  return {
    ...world,
    tick: world.tick + 1,
  };
}

/**
 * A world at tick 0. `S-05` replaces this with real seeded initialisation from
 * a seed and a city; today it only establishes that a run starts at tick 0.
 */
export function createWorld(): World {
  return {
    version: SIM_VERSION,
    tick: 0,
  };
}
