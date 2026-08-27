/**
 * `fare.ts` — what a ride is worth, and how one starts and ends.
 *
 * ## Two classes, opposite incentives
 *
 * The per-fare clock has to *do* something, and both obvious choices are broken
 * alone: a fare that grows with time makes dawdling dominant, and a fare that
 * decays is just an always-running clock with extra steps. So it is a property
 * of the passenger, and choosing between them is the decision
 * (`DESIGN.md` §2.1):
 *
 * | | **Meter** | **Rush** |
 * |---|---|---|
 * | Fare | grows with time in the car | decays from a maximum |
 * | Incentive | take the scenic route, milk it | floor it, straight line |
 * | Failure | patience empties, they bail, **you get nothing** | decays to a floor, never zero |
 * | Risk | high ceiling, cliff edge | low variance, low ceiling |
 *
 * Two passengers on the same corner are then a real decision, and which one is
 * right changes with how much deadhead time you have banked.
 *
 * ## Money is integers
 *
 * Cash is in minor units — whole numbers, not 16.16. A fare is counted, not
 * measured, and a score that is the sum of a few hundred integers is exactly
 * reproducible by the replay validator without any fixed-point reasoning at all.
 *
 * ## Radii, and the arithmetic bound
 *
 * Pickup and drop-off are proximity tests between two *absolute* positions, and
 * squaring an absolute coordinate overflows (ADR 0003). Every test here rejects
 * on a cheap per-axis comparison first and only squares the surviving
 * **relative offset**, which is at most a few units by construction. See
 * {@link withinRadius}.
 */
import { carSpeed } from './car.js';
import { beginFare, endFare, isDriving } from './clock.js';
import { fxAbs, fxFromRatio, fxMul } from './fx.js';
import { despawnPassenger, isPassengerActive, isRush, passengerCount } from './passengers.js';
import {
  Car,
  MAX_PASSENGERS,
  NO_CARRIER,
  NO_PASSENGER,
  Passenger,
  getCar,
  getPassenger,
  getPlayerCount,
  setCar,
  setPassenger,
  type World,
} from './world.js';

/** Words per city point, mirroring `@deadhead/proto`'s layout. */
const POINT_WORDS = 4;

export const FareTuning = {
  /** How close a cab must be to collect someone, in 16.16 units. */
  pickupRadius: fxFromRatio(3, 1),

  /** How close to the destination a cab must be to drop off, in 16.16 units. */
  dropoffRadius: fxFromRatio(4, 1),

  /**
   * Speed below which a cab counts as stopped, in units per tick.
   *
   * "Requires stopping (or near-stopping)" rather than an exact halt: an exact
   * halt is unreadable at speed and turns every pickup into a fiddle. This is
   * about 4 units/second.
   */
  stoppedSpeed: fxFromRatio(4, 30),

  /**
   * Cap on how far a fare may be sent, in **whole world units**. `0` disables it.
   *
   * **Zero by default, and that default is load-bearing**: at 0 the destination
   * is drawn with the exact same single RNG call it always was, so the goldens
   * are untouched and this constant is inert until somebody tunes it.
   *
   * It exists because Anmol's second playtest found fares taking 30+ seconds.
   * Measured across City 01's 380 spawn×destination pairs at top speed (with a
   * 1.3x grid-detour factor): **median 25 s, 77% over 15 s, 36% over 30 s, worst
   * 53 s.** The destination was chosen uniformly at random from all 19 with no
   * regard to where the passenger stood, so a corner-to-corner haul was exactly
   * as likely as a short hop.
   *
   * ⚠️ **A hard 15 s cap is not the right answer** and the numbers say so: it
   * discards 77% of the pairs and leaves a *median of 4 destinations per spawn,
   * minimum 2* — that is not tuning, it is shrinking City 01 to a fraction of
   * itself and making routes repetitive. Something in the 500–650 range keeps
   * variety while cutting the tail. The playtest picks it.
   */
  maxFareUnits: 0,

  /** What a `Meter` fare is worth the instant it starts, in minor units. */
  meterBase: 200,

  /** What a `Meter` fare gains per tick. Roughly 120 a second. */
  meterPerTick: 4,

  /** Ceiling on a `Meter` fare, so an infinitely long ride is not an infinite score. */
  meterMax: 8_000,

  /** What a `Rush` fare is worth the instant it starts. */
  rushMax: 5_000,

  /** What a `Rush` fare loses per tick. Reaches the floor in about 23 seconds. */
  rushDecayPerTick: 6,

  /**
   * What a `Rush` fare can never fall below. **Non-zero on purpose**
   * (`DESIGN.md` §2.1): a Rush passenger's failure mode is a poor fare, not a
   * lost one. Only a `Meter` bail pays nothing.
   */
  rushFloor: 800,
} as const;

/**
 * What the fare in cab `slot` is worth right now, in minor units.
 *
 * Zero for an empty cab. Reads the per-fare clock that `S-11` owns, so the two
 * clocks stay the single source of truth for elapsed time.
 */
export function fareValue(world: World, slot: number): number {
  const passenger = getCar(world, slot, Car.CarriedPassenger);
  if (passenger === NO_PASSENGER) return 0;

  const ticks = getCar(world, slot, Car.FareTicks);

  if (isRush(world, passenger)) {
    const decayed = FareTuning.rushMax - FareTuning.rushDecayPerTick * ticks;
    return decayed > FareTuning.rushFloor ? decayed : FareTuning.rushFloor;
  }

  const grown = FareTuning.meterBase + FareTuning.meterPerTick * ticks;
  return grown < FareTuning.meterMax ? grown : FareTuning.meterMax;
}

/**
 * True if `(bx, by)` is within `radius` of `(ax, ay)`.
 *
 * The per-axis rejection is not an optimisation. Positions are absolute and
 * reach ±2048 units; squaring one overflows 16.16 by an order of magnitude
 * (ADR 0003). Rejecting on `|dx| > radius` first guarantees that anything which
 * reaches the multiply is a small relative offset.
 */
export function withinRadius(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): boolean {
  const dx = bx - ax;
  if (fxAbs(dx) > radius) return false;
  const dy = by - ay;
  if (fxAbs(dy) > radius) return false;

  return fxMul(dx, dx) + fxMul(dy, dy) <= fxMul(radius, radius);
}

/**
 * Resolve pickups, drop-offs and bails for one tick.
 *
 * Runs **after** passengers and **before** the clocks, so a cab that collects
 * someone this tick is already carrying when `clock.ts` decides whether the
 * deadhead clock moves. That is what makes the pickup tick not burn deadhead —
 * see the tick rule in `clock.ts`.
 */
export function stepFares(world: World): void {
  const city = world.city;
  if (city === undefined) return;

  resolveBails(world);
  resolveDropoffs(world, city.packed.destinations);
  resolvePickups(world);
}

/** A `Meter` passenger whose patience ran out while aboard. Pays exactly zero. */
function resolveBails(world: World): void {
  for (let slot = 0; slot < getPlayerCount(world); slot += 1) {
    const passenger = getCar(world, slot, Car.CarriedPassenger);
    if (passenger === NO_PASSENGER) continue;
    if (getPassenger(world, passenger, Passenger.PatienceTicks) > 0) continue;

    // No cash, no delivery, no deadhead bonus. endFare(delivered: false) is
    // what encodes all three.
    endFare(world, slot, false);
    despawnPassenger(world, passenger);
  }
}

function resolveDropoffs(world: World, destinations: Int32Array): void {
  for (let slot = 0; slot < getPlayerCount(world); slot += 1) {
    const passenger = getCar(world, slot, Car.CarriedPassenger);
    if (passenger === NO_PASSENGER) continue;
    if (carSpeed(world, slot) > FareTuning.stoppedSpeed) continue;

    const destination = getPassenger(world, passenger, Passenger.Destination) * POINT_WORDS;
    if (destination < 0 || destination >= destinations.length) continue;

    const inRange = withinRadius(
      destinations[destination] as number,
      destinations[destination + 1] as number,
      getCar(world, slot, Car.X),
      getCar(world, slot, Car.Y),
      FareTuning.dropoffRadius,
    );
    if (!inRange) continue;

    setCar(world, slot, Car.Cash, getCar(world, slot, Car.Cash) + fareValue(world, slot));
    endFare(world, slot, true);
    despawnPassenger(world, passenger);
  }
}

/**
 * Collect anyone standing close enough to a stopped cab.
 *
 * Contests are resolved by cab slot order, which is stable and therefore
 * deterministic. `M-08` replaces this with a hail lock so a contest is decided
 * by positioning and braking rather than a frame-perfect coin flip — the flag
 * for it is already reserved in `PassengerFlags`.
 */
function resolvePickups(world: World): void {
  for (let slot = 0; slot < getPlayerCount(world); slot += 1) {
    if (getCar(world, slot, Car.CarriedPassenger) !== NO_PASSENGER) continue;
    if (!isDriving(world, slot)) continue;
    if (carSpeed(world, slot) > FareTuning.stoppedSpeed) continue;

    const carX = getCar(world, slot, Car.X);
    const carY = getCar(world, slot, Car.Y);

    for (let passenger = 0; passenger < MAX_PASSENGERS; passenger += 1) {
      if (!isPassengerActive(world, passenger)) continue;
      if (getPassenger(world, passenger, Passenger.Carrier) !== NO_CARRIER) continue;

      const inRange = withinRadius(
        getPassenger(world, passenger, Passenger.X),
        getPassenger(world, passenger, Passenger.Y),
        carX,
        carY,
        FareTuning.pickupRadius,
      );
      if (!inRange) continue;

      setPassenger(world, passenger, Passenger.Carrier, slot);
      beginFare(world, slot, passenger);
      break;
    }
  }
}

/** Total earned by a cab so far, in minor units. `G-04` turns this into a score. */
export function cashOf(world: World, slot: number): number {
  return getCar(world, slot, Car.Cash);
}

/** Waiting passengers, for the HUD and for tests. */
export function waitingCount(world: World): number {
  let waiting = 0;
  for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
    if (!isPassengerActive(world, slot)) continue;
    if (getPassenger(world, slot, Passenger.Carrier) === NO_CARRIER) waiting += 1;
  }
  return waiting <= passengerCount(world) ? waiting : passengerCount(world);
}
