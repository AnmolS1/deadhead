/**
 * `step()` — the only entry point into the simulation.
 *
 * It advances the tick counter and records each player's input. `S-06` onward
 * attach the car model, collision, traffic, passengers, fares and clocks to it,
 * in that order.
 */
import { Car, cloneWorld, getPlayerCount, getTick, setCar, type World } from './world.js';
import { Header } from './world.js';
import type { Inputs } from './types.js';

/**
 * Advance the world by exactly one tick.
 *
 * Pure: a function of its arguments and nothing else, and it never mutates the
 * world it was given. Same `(world, inputs)` must produce the same output in the
 * browser, in a Durable Object, and in the replay validator — byte for byte, in
 * every engine. That guarantee is what `S-14` gates on.
 *
 * There is **no `dt` parameter**: the timestep is `TICK_HZ`, a compile-time
 * constant, and rates are expressed in per-tick units rather than multiplied by
 * a fixed-point dt that cannot represent 1/30 exactly. See `constants.ts` and
 * CLAUDE.md hard invariant #2.
 *
 * @param world  State at tick `t`. Treated as immutable.
 * @param inputs One packed input byte per player, dense, for tick `t`.
 * @returns State at tick `t + 1`.
 */
export function step(world: World, inputs: Inputs): World {
  const next = cloneWorld(world);

  next.data[Header.Tick] = getTick(world) + 1;

  // Recorded now so a dropped packet repeats the last byte rather than
  // stalling the cab (M-03). The car model in S-06 reads it from here.
  const players = getPlayerCount(next);
  for (let slot = 0; slot < players; slot += 1) {
    setCar(next, slot, Car.LastInput, (inputs[slot] ?? 0) & 0xff);
  }

  return next;
}
