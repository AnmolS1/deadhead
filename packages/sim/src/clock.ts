/**
 * `clock.ts` — the mechanic.
 *
 * Every timed taxi game since *Crazy Taxi* runs a global countdown. This one
 * inverts it: **the global clock burns only while the cab is empty.** Pick
 * someone up and it freezes; a separate per-fare clock settles the fare.
 *
 * The consequence that makes the whole game different is that distance stops
 * being a cost. A long fare is free in global-clock terms, so the question
 * changes from "how fast can I get there" to "where does this leave me". See
 * `DESIGN.md` §1.
 *
 * ## The tick rule
 *
 * `S-11` asks for one thing to be decided rather than left to loop order: does
 * the tick you pick someone up on burn deadhead? The answer here, and the
 * single sentence the rest of this file implements:
 *
 * > **The deadhead clock decrements on a tick if and only if the cab is empty
 * > at the *end* of that tick. The fare clock increments if and only if the cab
 * > is carrying at the end of that tick.**
 *
 * So the pickup tick does **not** burn deadhead and **does** count toward the
 * fare; the drop-off tick **does** burn deadhead and does **not** count toward
 * the fare. There is no grace period in either direction.
 *
 * Two properties follow, and both are tested to the tick:
 *
 * - Exactly one of the two clocks advances per tick, per live cab. So
 *   `deadheadBurned + fareTicksAccrued === ticksElapsed`, always.
 * - The rule is stated in terms of end-of-tick state, which means it does not
 *   depend on where pickup resolution sits inside `step()`. When `S-09` and
 *   `S-10` insert themselves before this, the semantics do not move.
 *
 * ## Multiplayer
 *
 * Each cab has an independent deadhead clock — that is what makes stealing a
 * fare simultaneously the best offence and the best defence (`DESIGN.md` §2.3):
 * you gain a frozen clock and your opponent keeps burning theirs. A clock that
 * reaches zero **eliminates** that cab. The win condition built on top of that
 * ("first to N, or last one still driving") is `M-09`'s; this file only sets
 * the flag.
 */
import { TICK_HZ } from './constants.js';
import {
  Car,
  CarFlags,
  NO_PASSENGER,
  WorldFlags,
  getCar,
  getPlayerCount,
  setCar,
  type World,
} from './world.js';
import { Header } from './world.js';

/**
 * Clock tuning. As with `CarTuning`, authored in seconds and stored in ticks.
 */
export const ClockTuning = {
  /**
   * Starting deadhead bank. `DESIGN.md` §7 flags 180 s as *inherited, not
   * designed* — it came from the ancestor game and has never been playtested
   * here. Expect this to move.
   */
  startingDeadheadTicks: 180 * TICK_HZ,

  /**
   * Deadhead time returned on a completed delivery.
   *
   * **Zero. Decided (`D-04`, ADR 0006): the bank does not refill.** Three
   * minutes is the run, and the end of the three minutes is the end of the
   * game.
   *
   * That makes the deadhead bank a fixed budget rather than a resource you can
   * farm, which is what keeps the scarce thing *scarce*. A refill would mean a
   * good player's run has no end, and a leaderboard where the best score is
   * "however long you could keep going" measures endurance rather than routing.
   *
   * The mechanism is kept — `grantDeadhead` still works, and `G-01` may want it
   * for a crash penalty's inverse — but nothing grants time today.
   */
  deliveryBonusTicks: 0,
} as const;

/** Set every cab's deadhead bank to the starting value. Called by `createWorld`. */
export function initClocks(world: World): void {
  for (let slot = 0; slot < getPlayerCount(world); slot += 1) {
    setCar(world, slot, Car.DeadheadTicks, ClockTuning.startingDeadheadTicks);
    setCar(world, slot, Car.FareTicks, 0);
  }
}

/** True while this cab still has deadhead time and has not been eliminated. */
export function isDriving(world: World, slot: number): boolean {
  return (getCar(world, slot, Car.Flags) & CarFlags.Eliminated) === 0;
}

/** True while this cab has someone in the back — which is when the clock is frozen. */
export function isCarrying(world: World, slot: number): boolean {
  return getCar(world, slot, Car.CarriedPassenger) !== NO_PASSENGER;
}

/**
 * Start a fare. `S-10` owns what the fare is worth; this owns when its clock
 * starts.
 *
 * The fare clock resets to zero here, so the pickup tick is fare tick 0 and is
 * counted by {@link stepClocks} at the end of this same tick.
 */
export function beginFare(world: World, slot: number, passenger: number): void {
  setCar(world, slot, Car.CarriedPassenger, passenger);
  setCar(world, slot, Car.FareTicks, 0);
}

/**
 * End a fare, whether by delivery or by the passenger bailing.
 *
 * @param delivered `true` for a completed drop-off, `false` when the passenger
 *   gave up. Only a completed delivery returns deadhead time or counts toward
 *   the delivery total; a bail pays exactly zero (`DESIGN.md` §2.1).
 * @returns ticks the fare ran for, which is what `S-10` prices.
 */
export function endFare(world: World, slot: number, delivered: boolean): number {
  const fareTicks = getCar(world, slot, Car.FareTicks);

  setCar(world, slot, Car.CarriedPassenger, NO_PASSENGER);
  setCar(world, slot, Car.FareTicks, 0);

  if (delivered) {
    setCar(world, slot, Car.Deliveries, getCar(world, slot, Car.Deliveries) + 1);
    grantDeadhead(world, slot, ClockTuning.deliveryBonusTicks);
  }

  return fareTicks;
}

/**
 * Add deadhead time to a cab's bank.
 *
 * Refuses to revive an eliminated cab: elimination is final, and `M-09`'s "last
 * one still driving" is only a win condition if nobody can come back.
 */
export function grantDeadhead(world: World, slot: number, ticks: number): void {
  if (ticks <= 0 || !isDriving(world, slot)) return;
  setCar(world, slot, Car.DeadheadTicks, getCar(world, slot, Car.DeadheadTicks) + ticks);
}

/**
 * Advance both clocks for one cab by one tick.
 *
 * **Must run last in `step()`**, after movement and after pickup resolution,
 * because the rule is written in terms of end-of-tick state.
 */
export function stepClocks(world: World, slot: number): void {
  // An eliminated cab burns nothing. Without this the bank runs negative, and
  // M-10's "disconnecting is never an advantage" accounting reads the wrong
  // number when it compares banks.
  if (!isDriving(world, slot)) return;

  if (isCarrying(world, slot)) {
    setCar(world, slot, Car.FareTicks, getCar(world, slot, Car.FareTicks) + 1);
    return;
  }

  const remaining = getCar(world, slot, Car.DeadheadTicks) - 1;
  setCar(world, slot, Car.DeadheadTicks, remaining > 0 ? remaining : 0);

  if (remaining <= 0) {
    setCar(world, slot, Car.Flags, getCar(world, slot, Car.Flags) | CarFlags.Eliminated);
  }
}

/**
 * Clear {@link WorldFlags.Running} once no cab is still driving.
 *
 * This is the floor of the end condition, not the whole of it: `G-01` ends a
 * single-player run here, and `M-09` adds "first to N delivered fares" on top.
 * Keeping the last-one-standing half in the sim means both modes agree about
 * when a run is over without either owning the other's rules.
 */
export function stepRunEnd(world: World): void {
  for (let slot = 0; slot < getPlayerCount(world); slot += 1) {
    if (isDriving(world, slot)) return;
  }
  world.data[Header.Flags] &= ~WorldFlags.Running;
}
