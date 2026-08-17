/**
 * `passengers.ts` — who is standing where, and why there.
 *
 * ## The demand field
 *
 * Because the clock only burns while empty, **where a fare leaves you is worth
 * more than how fast you drove it** (`DESIGN.md` §2.2). That only matters if the
 * map has somewhere it wants to be — so passengers do not spawn uniformly. They
 * spawn around a *demand field* built from the city's anchors, and that field
 * **migrates** across a run: a stadium lets out, a district goes quiet, a queue
 * builds at the station.
 *
 * Ending a fare inside a hot zone is the reward for good routing. That is the
 * entire strategic game, and it does not exist at all if the clock never pauses.
 *
 * ## Whole units, not fixed point
 *
 * Demand is computed in **whole units**, not 16.16. That is not laziness — it is
 * ADR 0003. A squared distance between a spawn point and an anchor is a squared
 * *absolute* distance, and at up to 4096 units apart it is twenty times past the
 * 16.16 squarable bound. In whole units, `4096² = 16.7M`, which sits in an int32
 * with room to spare. Demand does not need sub-unit precision; correctness at
 * map scale is not optional.
 *
 * ## Determinism
 *
 * Every spawn decision comes from the world's PRNG, whose state is inside the
 * world and therefore hashed and replayed. Nothing here reads wall-clock time or
 * player-independent randomness. Two clients on the same seed and the same city
 * see the same passengers appear on the same ticks, forever — which is what
 * makes `DESIGN.md` §4's daily mode nearly free.
 */
import { TICK_HZ } from './constants.js';
import type { RuntimeCity } from './city.js';
import { fxFloorToInt } from './fx.js';
import { rngNextBelow, rngNextU32 } from './rng.js';
import {
  Car,
  Header,
  MAX_PASSENGERS,
  NO_CARRIER,
  Passenger,
  PassengerFlags,
  getCar,
  getPassenger,
  getPlayerCount,
  getTick,
  rngOf,
  setPassenger,
  type World,
} from './world.js';

/** Words per city point / demand anchor, mirroring `@deadhead/proto`'s layout. */
const POINT_WORDS = 4;
const DEMAND_WORDS = 4;

/** Full weight of an anchor at its peak, before falloff. */
const PEAK_WEIGHT = 256;

export const PassengerTuning = {
  /**
   * How often a spawn is attempted. An attempt can still fail if the population
   * is at cap or the city has nowhere to put anyone.
   */
  spawnIntervalTicks: Math.round(TICK_HZ * 1.5),

  /** Cap on passengers waiting at once. Bounded by the world layout regardless. */
  maxWaiting: 24,

  /** How long a `Meter` passenger tolerates being ignored, and then being driven around. */
  meterPatienceTicks: 75 * TICK_HZ,

  /**
   * How long a `Rush` passenger waits before giving up. They never bail once
   * aboard — their fare decays to a floor instead (`DESIGN.md` §2.1).
   */
  rushPatienceTicks: 40 * TICK_HZ,

  /**
   * Chance in 256 that a new passenger is `Rush`.
   *
   * **Open question, `DESIGN.md` §7.2:** whether this should shift across a run
   * (early Meter-rich, late Rush-rich) to give a run an arc. Implemented as a
   * flat knob because the answer is a playtest result.
   */
  rushShareOf256: 96,

  /**
   * How long the demand field takes to complete one migration, in ticks.
   *
   * Matched to the starting deadhead bank so a full run sees roughly one cycle.
   * It is a *cycle*, not a run-length, so it needs no notion of when the run
   * ends — which is good, because the run ends when a clock hits zero and
   * nothing knows when that is in advance.
   */
  migrationPeriodTicks: 180 * TICK_HZ,

  /**
   * A waiting passenger further than this from every cab is removed, in whole
   * units — keeping the population near the action rather than scattered across
   * a city nobody is in.
   */
  despawnDistanceUnits: 900,

  /** Grace before distance despawn applies, so a passenger cannot flicker in and out. */
  despawnGraceTicks: 10 * TICK_HZ,
} as const;

/**
 * Demand at a point, in arbitrary units, for the given tick.
 *
 * Each anchor contributes a quadratic falloff inside its radius, scaled by how
 * near the tick is to that anchor's peak phase. The result is a field that is
 * smooth in space and cyclic in time.
 *
 * `x` and `y` are **whole units**, not 16.16 — see the note at the top of this
 * file about why that is a correctness requirement rather than a shortcut.
 */
export function demandAt(city: RuntimeCity, tick: number, x: number, y: number): number {
  const anchors = city.packed.demandAnchors;
  let total = 0;

  const phaseNow = migrationPhase(tick);

  for (let i = 0; i < anchors.length; i += DEMAND_WORDS) {
    const anchorX = fxFloorToInt(anchors[i] as number);
    const anchorY = fxFloorToInt(anchors[i + 1] as number);
    const radius = fxFloorToInt(anchors[i + 2] as number);
    if (radius <= 0) continue;

    const dx = x - anchorX;
    const dy = y - anchorY;
    const distanceSquared = dx * dx + dy * dy;
    const radiusSquared = radius * radius;
    if (distanceSquared >= radiusSquared) continue;

    // Quadratic falloff, normalised to PEAK_WEIGHT at the centre. The division
    // is integer and exact-enough; demand is a weighting, not a measurement.
    const falloff = Math.floor(((radiusSquared - distanceSquared) * PEAK_WEIGHT) / radiusSquared);
    // Kept integer at every step. IEEE division would be deterministic too, but
    // an integer weighting cannot be argued with.
    total += Math.floor((falloff * anchorWeight(anchors[i + 3] as number, phaseNow)) / PEAK_WEIGHT);
  }

  return total;
}

/** Where the migration cycle stands at this tick, in 1/256ths. */
function migrationPhase(tick: number): number {
  const period = PassengerTuning.migrationPeriodTicks;
  return Math.floor(((tick % period) * PEAK_WEIGHT) / period);
}

/**
 * How strongly an anchor is contributing right now.
 *
 * A triangular window around the anchor's peak phase, wrapped so the cycle is
 * seamless, with a floor so a district never goes completely dead — an empty
 * half of the map is not interesting, it is just empty.
 */
function anchorWeight(phase: number, now: number): number {
  const raw = Math.abs(((phase % PEAK_WEIGHT) + PEAK_WEIGHT) % PEAK_WEIGHT) - now;
  const wrapped = Math.abs(((raw % PEAK_WEIGHT) + PEAK_WEIGHT) % PEAK_WEIGHT);
  const distance = Math.min(wrapped, PEAK_WEIGHT - wrapped);
  // distance is 0..128; full weight at the peak, quarter weight at the antipode.
  return PEAK_WEIGHT - Math.floor((distance * 3 * PEAK_WEIGHT) / (4 * (PEAK_WEIGHT / 2)));
}

/** Passengers currently occupying a slot. */
export function passengerCount(world: World): number {
  return world.data[Header.PassengerCount] as number;
}

/** True if this slot holds a live passenger. */
export function isPassengerActive(world: World, slot: number): boolean {
  return (getPassenger(world, slot, Passenger.Flags) & PassengerFlags.Active) !== 0;
}

/** True if this passenger is a `Rush` rather than a `Meter`. */
export function isRush(world: World, slot: number): boolean {
  return (getPassenger(world, slot, Passenger.Flags) & PassengerFlags.Rush) !== 0;
}

/** Remove a passenger from the world, whatever the reason. */
export function despawnPassenger(world: World, slot: number): void {
  if (!isPassengerActive(world, slot)) return;
  for (const field of Object.values(Passenger)) setPassenger(world, slot, field, 0);
  setPassenger(world, slot, Passenger.Carrier, NO_CARRIER);
  world.data[Header.PassengerCount] = passengerCount(world) - 1;
}

/**
 * Advance spawning, patience and despawning by one tick.
 *
 * Runs **after** movement and **before** the clocks, so a passenger picked up
 * this tick is already aboard when `clock.ts` decides whether the deadhead clock
 * moves. See `step()`.
 */
export function stepPassengers(world: World): void {
  const city = world.city;
  if (city === undefined) return;

  const tick = getTick(world);

  expireAndDespawn(world, tick);

  if (tick % PassengerTuning.spawnIntervalTicks === 0) {
    trySpawn(world, city, tick);
  }
}

function expireAndDespawn(world: World, tick: number): void {
  for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
    if (!isPassengerActive(world, slot)) continue;

    const carrier = getPassenger(world, slot, Passenger.Carrier);
    const carried = carrier !== NO_CARRIER;

    // A Rush passenger's clock stops once they are aboard: they never bail,
    // their fare just decays. A Meter passenger keeps losing patience in the
    // car, which is exactly their failure mode.
    if (!carried || !isRush(world, slot)) {
      const remaining = getPassenger(world, slot, Passenger.PatienceTicks) - 1;
      setPassenger(world, slot, Passenger.PatienceTicks, remaining > 0 ? remaining : 0);

      if (remaining <= 0) {
        // A carried passenger out of patience is a bail, which `S-10` prices at
        // exactly zero. Clearing the cab is that task's job, so leave the
        // passenger for it to find rather than yanking them out mid-ride.
        if (!carried) despawnPassenger(world, slot);
        continue;
      }
    }

    if (carried) continue;
    if (tick - getPassenger(world, slot, Passenger.SpawnTick) < PassengerTuning.despawnGraceTicks) {
      continue;
    }
    if (farFromEveryCab(world, slot)) despawnPassenger(world, slot);
  }
}

/** Whole-unit distance test. See the note at the top of this file. */
function farFromEveryCab(world: World, slot: number): boolean {
  const x = fxFloorToInt(getPassenger(world, slot, Passenger.X));
  const y = fxFloorToInt(getPassenger(world, slot, Passenger.Y));
  const limit = PassengerTuning.despawnDistanceUnits * PassengerTuning.despawnDistanceUnits;

  for (let cab = 0; cab < getPlayerCount(world); cab += 1) {
    const dx = x - fxFloorToInt(getCar(world, cab, Car.X));
    const dy = y - fxFloorToInt(getCar(world, cab, Car.Y));
    if (dx * dx + dy * dy <= limit) return false;
  }
  return true;
}

function trySpawn(world: World, city: RuntimeCity, tick: number): void {
  const spawns = city.packed.spawns;
  const destinations = city.packed.destinations;
  if (spawns.length === 0 || destinations.length === 0) return;

  let waiting = 0;
  let free = -1;
  for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
    if (isPassengerActive(world, slot)) {
      if (getPassenger(world, slot, Passenger.Carrier) === NO_CARRIER) waiting += 1;
    } else if (free < 0) {
      free = slot;
    }
  }
  if (free < 0 || waiting >= PassengerTuning.maxWaiting) return;

  const rng = rngOf(world);
  const chosen = pickSpawnPointByDemand(city, tick, rng);
  if (chosen < 0) return;

  const base = chosen * POINT_WORDS;
  const destination = rngNextBelow(rng, destinations.length / POINT_WORDS);
  const rush = rngNextBelow(rng, PEAK_WEIGHT) < PassengerTuning.rushShareOf256;

  setPassenger(
    world,
    free,
    Passenger.Flags,
    PassengerFlags.Active | (rush ? PassengerFlags.Rush : 0),
  );
  setPassenger(world, free, Passenger.X, spawns[base] as number);
  setPassenger(world, free, Passenger.Y, spawns[base + 1] as number);
  setPassenger(world, free, Passenger.Destination, destination);
  setPassenger(world, free, Passenger.SpawnTick, tick);
  setPassenger(
    world,
    free,
    Passenger.PatienceTicks,
    rush ? PassengerTuning.rushPatienceTicks : PassengerTuning.meterPatienceTicks,
  );
  setPassenger(world, free, Passenger.Carrier, NO_CARRIER);

  world.data[Header.PassengerCount] = passengerCount(world) + 1;
}

/**
 * Choose a spawn point, weighted by demand.
 *
 * Every point gets a floor of 1 so a cold district is unlikely rather than
 * impossible — a corner of the map that can *never* produce a fare is a corner
 * players correctly learn to ignore forever, which shrinks the city for free.
 */
function pickSpawnPointByDemand(city: RuntimeCity, tick: number, rng: Int32Array): number {
  const spawns = city.packed.spawns;
  const count = spawns.length / POINT_WORDS;

  let total = 0;
  for (let i = 0; i < count; i += 1) {
    total += weightOfSpawn(city, tick, i);
  }
  if (total <= 0) return -1;

  // A u32 draw reduced into the weight range. Deterministic, and the modulo
  // bias is irrelevant for a weighting — unlike rngNextBelow's use for a fair
  // pick, where it is not.
  let target = rngNextU32(rng) % total;
  for (let i = 0; i < count; i += 1) {
    target -= weightOfSpawn(city, tick, i);
    if (target < 0) return i;
  }
  return count - 1;
}

function weightOfSpawn(city: RuntimeCity, tick: number, index: number): number {
  const spawns = city.packed.spawns;
  const base = index * POINT_WORDS;
  const x = fxFloorToInt(spawns[base] as number);
  const y = fxFloorToInt(spawns[base + 1] as number);
  return 1 + demandAt(city, tick, x, y);
}
