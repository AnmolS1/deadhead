/**
 * `step()` — the only entry point into the simulation.
 *
 * It advances the tick counter and records each player's input. `S-06` onward
 * attach the car model, collision, traffic, passengers, fares and clocks to it,
 * in that order.
 */
import { stepCar } from './car.js';
import { stepClocks, stepRunEnd } from './clock.js';
import { sweepCar } from './collide.js';
import type { Inputs } from './types.js';
import {
  Car,
  Header,
  cloneWorld,
  getCar,
  getPlayerCount,
  getTick,
  setCar,
  type World,
} from './world.js';

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

  // Inputs are recorded before anything reads them, so a dropped packet
  // repeats the last byte rather than stalling the cab (M-03).
  const players = getPlayerCount(next);
  for (let slot = 0; slot < players; slot += 1) {
    setCar(next, slot, Car.LastInput, (inputs[slot] ?? 0) & 0xff);
  }

  // Every cab advances from the same pre-step state, so slot order cannot
  // matter. It will matter the moment S-08 collision or S-09 contested pickup
  // land, and both are specified to resolve by slot order deterministically.
  for (let slot = 0; slot < players; slot += 1) {
    const fromX = getCar(next, slot, Car.X);
    const fromY = getCar(next, slot, Car.Y);
    stepCar(next, slot);
    // Collision runs per cab, immediately after that cab moves, so the sweep
    // sees the movement it is resolving. There is no car-car collision in v1
    // (DESIGN.md §2.3), so slot order still cannot matter.
    if (next.city !== undefined) sweepCar(next, slot, next.city.statics, fromX, fromY);
  }

  // S-09's passenger pickup and drop-off resolution slots in HERE, between
  // movement and the clocks.

  // Clocks run last, on purpose. The rule in clock.ts is written in terms of
  // end-of-tick state — "the deadhead clock decrements iff the cab is empty at
  // the end of the tick" — which is what keeps the pickup-tick semantics stable
  // when S-09 inserts itself above.
  for (let slot = 0; slot < players; slot += 1) {
    stepClocks(next, slot);
  }
  stepRunEnd(next);

  return next;
}
