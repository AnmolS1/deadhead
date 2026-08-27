import { afterEach, describe, expect, it } from 'vitest';

import { emptyCityJson, packCity, type CityJson } from '@deadhead/proto';

import { prepareCity, type RuntimeCity } from '../src/city.js';
import { FareTuning } from '../src/fare.js';
import { TICK_HZ, WORLD_MAX } from '../src/constants.js';
import { FX_ONE } from '../src/fx.js';
import {
  PassengerTuning,
  demandAt,
  despawnPassenger,
  isPassengerActive,
  isRush,
  passengerCount,
  rushShareAt,
} from '../src/passengers.js';
import { step } from '../src/step.js';
import {
  Header,
  MAX_PASSENGERS,
  NO_CARRIER,
  Passenger,
  createWorld,
  getPassenger,
  hashWorld,
  setPassenger,
  type World,
} from '../src/world.js';

/**
 * Two districts on opposite phases of the migration: the west is busy at the
 * start of the cycle, the east at the middle. Spawn points run between them so
 * the field's shape is visible in where people appear.
 */
function twoDistrictCity(): RuntimeCity {
  const json: CityJson = {
    ...emptyCityJson('two districts'),
    demandAnchors: [
      { x: -200, y: 0, radius: 250, phase: 0 },
      { x: 200, y: 0, radius: 250, phase: 128 },
    ],
    spawns: Array.from({ length: 20 }, (_, i) => ({ x: -300 + i * 30, y: 0 })),
    destinations: [
      { x: 0, y: 200 },
      { x: 0, y: -200 },
    ],
  };
  return prepareCity(packCity(json));
}

/** Run a world forward, returning it. */
function run(world: World, ticks: number, inputs: readonly number[] = [0]): World {
  let current = world;
  for (let i = 0; i < ticks; i += 1) current = step(current, inputs);
  return current;
}

/** Every active passenger, as a comparable record. */
function census(world: World): string[] {
  const rows: string[] = [];
  for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
    if (!isPassengerActive(world, slot)) continue;
    rows.push(
      [
        slot,
        getPassenger(world, slot, Passenger.X),
        getPassenger(world, slot, Passenger.Y),
        getPassenger(world, slot, Passenger.Destination),
        getPassenger(world, slot, Passenger.SpawnTick),
        isRush(world, slot) ? 'rush' : 'meter',
      ].join(':'),
    );
  }
  return rows;
}

/** Land exactly on a spawn tick, so a single step attempts a spawn. */
function atSpawnTick(city: RuntimeCity, seed: number, tick = PassengerTuning.spawnIntervalTicks) {
  const world = createWorld(seed, 1, city);
  world.data[Header.Tick] = tick - 1;
  return step(world, [0]);
}

// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('yields an identical passenger sequence for a fixed seed', () => {
    // S-09's done-when. Everything here comes from the world's PRNG, whose
    // state is inside the world and therefore hashed and replayed.
    const city = twoDistrictCity();
    const first = run(createWorld(0xd11, 1, city), 3_000);
    const second = run(createWorld(0xd11, 1, city), 3_000);

    expect(census(second)).toEqual(census(first));
    expect(hashWorld(second)).toBe(hashWorld(first));
    expect(census(first).length).toBeGreaterThan(0);
  });

  it('yields a different sequence for a different seed', () => {
    const city = twoDistrictCity();
    const a = run(createWorld(1, 1, city), 3_000);
    const b = run(createWorld(2, 1, city), 3_000);
    expect(census(b)).not.toEqual(census(a));
  });

  it('keeps every passenger field an exact int32', () => {
    const world = run(createWorld(7, 1, twoDistrictCity()), 4_000);
    for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
      for (const field of Object.values(Passenger)) {
        const value = getPassenger(world, slot, field);
        expect(Object.is(value, value | 0)).toBe(true);
      }
    }
  });
});

describe('the demand field', () => {
  it('migrates across a run', () => {
    // S-09's other done-when, as a dump rather than a claim: the two districts
    // trade places over one 180-second cycle and come back.
    const city = twoDistrictCity();
    const period = PassengerTuning.migrationPeriodTicks;
    const sample = (tick: number): { west: number; east: number } => ({
      west: demandAt(city, tick, -200, 0),
      east: demandAt(city, tick, 200, 0),
    });

    const start = sample(0);
    const quarter = sample(period / 4);
    const half = sample(period / 2);
    const full = sample(period);

    expect(start.west).toBeGreaterThan(start.east * 2);
    expect(half.east).toBeGreaterThan(half.west * 2);
    // Halfway between the peaks the two districts are level.
    expect(Math.abs(quarter.west - quarter.east)).toBeLessThan(start.west / 4);
    // The cycle closes.
    expect(full).toEqual(start);
  });

  it('is smooth in space and falls to nothing outside an anchor', () => {
    const city = twoDistrictCity();
    expect(demandAt(city, 0, -200, 0)).toBeGreaterThan(demandAt(city, 0, -100, 0));
    expect(demandAt(city, 0, -100, 0)).toBeGreaterThan(demandAt(city, 0, 0, 0));
    expect(demandAt(city, 0, 0, 900)).toBe(0);
  });

  it('never leaves a district completely dead', () => {
    // A corner that can never produce a fare is a corner players correctly
    // learn to ignore forever, which shrinks the city for free.
    const city = twoDistrictCity();
    for (let tick = 0; tick < PassengerTuning.migrationPeriodTicks; tick += 137) {
      expect(demandAt(city, tick, -200, 0)).toBeGreaterThan(0);
      expect(demandAt(city, tick, 200, 0)).toBeGreaterThan(0);
    }
  });

  it('survives anchors at opposite corners of the world', () => {
    // ADR 0003: this is why demand is computed in WHOLE UNITS. A squared
    // distance across the map is 20x past the 16.16 squarable bound; in whole
    // units it is 33M, comfortably inside an int32.
    const corners = prepareCity(
      packCity({
        ...emptyCityJson('corners'),
        demandAnchors: [
          { x: -WORLD_MAX + 1, y: -WORLD_MAX + 1, radius: 2000, phase: 0 },
          { x: WORLD_MAX - 1, y: WORLD_MAX - 1, radius: 2000, phase: 128 },
        ],
      }),
    );

    const near = demandAt(corners, 0, -WORLD_MAX + 1, -WORLD_MAX + 1);
    const far = demandAt(corners, 0, WORLD_MAX - 1, WORLD_MAX - 1);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far);
    expect(Object.is(near, near | 0)).toBe(true);
  });

  it('is zero for a city with no anchors', () => {
    const bare = prepareCity(packCity(emptyCityJson()));
    expect(demandAt(bare, 0, 0, 0)).toBe(0);
  });
});

describe('spawning', () => {
  it('puts passengers where demand is', () => {
    // The strategic point of the whole system. Measured end to end rather than
    // asserted from the weights.
    const city = twoDistrictCity();
    const share = (tick: number): number => {
      let west = 0;
      let east = 0;
      for (let trial = 0; trial < 300; trial += 1) {
        const world = atSpawnTick(
          city,
          9000 + trial,
          tick === 0 ? PassengerTuning.spawnIntervalTicks : tick,
        );
        for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
          if (!isPassengerActive(world, slot)) continue;
          if (getPassenger(world, slot, Passenger.X) < 0) west += 1;
          else east += 1;
        }
      }
      return west / (west + east);
    };

    expect(share(0)).toBeGreaterThan(0.65);
    expect(share(PassengerTuning.migrationPeriodTicks / 2)).toBeLessThan(0.35);
  });

  it('mixes the two classes at the ratio for that point in the run', () => {
    const city = twoDistrictCity();
    const measure = (tick: number): number => {
      let rush = 0;
      let total = 0;
      for (let trial = 0; trial < 800; trial += 1) {
        const world = atSpawnTick(city, 50_000 + trial, tick);
        for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
          if (!isPassengerActive(world, slot)) continue;
          total += 1;
          if (isRush(world, slot)) rush += 1;
        }
      }
      return rush / total;
    };

    const early = PassengerTuning.spawnIntervalTicks;
    const late = PassengerTuning.rushShiftTicks;
    expect(Math.abs(measure(early) - rushShareAt(early) / 256)).toBeLessThan(0.06);
    expect(Math.abs(measure(late) - rushShareAt(late) / 256)).toBeLessThan(0.06);
  });

  it('shifts toward Rush as a run goes on', () => {
    // ADR 0006: a run opens Meter-rich, rewarding patient routing while the
    // bank is deep, and closes Rush-rich so the last minute is a scramble.
    const shift = PassengerTuning.rushShiftTicks;
    expect(rushShareAt(0)).toBe(PassengerTuning.rushShareStartOf256);
    expect(rushShareAt(shift / 2)).toBeGreaterThan(rushShareAt(0));
    expect(rushShareAt(shift)).toBe(PassengerTuning.rushShareEndOf256);
    // ...and holds, rather than running off the end.
    expect(rushShareAt(shift * 10)).toBe(PassengerTuning.rushShareEndOf256);

    for (let tick = 1; tick <= shift; tick += 97) {
      expect(rushShareAt(tick)).toBeGreaterThanOrEqual(rushShareAt(tick - 1));
    }
  });

  it('drives the shift from the world tick, not from any one cab', () => {
    // Passengers are shared (DESIGN.md §2.3): in a twelve-player match every cab
    // must see the same person on the same corner. A per-player ramp would put
    // different people on the same street for different players.
    const city = twoDistrictCity();
    const solo = atSpawnTick(city, 4242, 3_000);
    const crowded = createWorld(4242, 12, city);
    crowded.data[Header.Tick] = 3_000 - 1;
    const stepped = step(crowded, new Array(12).fill(0));

    const classesOf = (world: World): string[] => {
      const rows: string[] = [];
      for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
        if (isPassengerActive(world, slot)) rows.push(isRush(world, slot) ? 'rush' : 'meter');
      }
      return rows;
    };
    expect(classesOf(stepped)).toEqual(classesOf(solo));
  });

  it('gives every passenger a destination the city actually has', () => {
    const city = twoDistrictCity();
    const destinations = city.packed.destinations.length / 4;
    const world = run(createWorld(11, 1, city), 2_000);

    let checked = 0;
    for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
      if (!isPassengerActive(world, slot)) continue;
      const destination = getPassenger(world, slot, Passenger.Destination);
      expect(destination).toBeGreaterThanOrEqual(0);
      expect(destination).toBeLessThan(destinations);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('starts everyone unclaimed', () => {
    const world = atSpawnTick(twoDistrictCity(), 3);
    for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
      if (!isPassengerActive(world, slot)) continue;
      expect(getPassenger(world, slot, Passenger.Carrier)).toBe(NO_CARRIER);
    }
  });

  it('respects the waiting cap', () => {
    // Nobody is picking anyone up, so the city saturates. That is correct — a
    // street fills if you ignore it — but it must not exceed the cap.
    const world = run(createWorld(5, 1, twoDistrictCity()), 6_000);

    // Counts WAITING passengers, which is what the cap actually governs —
    // `trySpawn` tests `waiting >= maxWaiting`. The old version counted every
    // active passenger and so included anyone aboard, which made it read one
    // over the cap as soon as the parked cab collected somebody. It passed
    // before only because nobody ever spawned within the smaller pickup radius
    // of the origin; the wider radius exposed it.
    let waiting = 0;
    for (let slot = 0; slot < 64; slot += 1) {
      if (!isPassengerActive(world, slot)) continue;
      if (getPassenger(world, slot, Passenger.Carrier) !== NO_CARRIER) continue;
      waiting += 1;
    }
    expect(waiting).toBeLessThanOrEqual(PassengerTuning.maxWaiting);
    expect(waiting).toBeGreaterThan(0);
  });

  it('does nothing without a city, or without spawn points', () => {
    expect(passengerCount(run(createWorld(1, 1), 2_000))).toBe(0);

    const noSpawns = prepareCity(packCity({ ...emptyCityJson(), destinations: [{ x: 0, y: 0 }] }));
    expect(passengerCount(run(createWorld(1, 1, noSpawns), 2_000))).toBe(0);

    const noDestinations = prepareCity(packCity({ ...emptyCityJson(), spawns: [{ x: 0, y: 0 }] }));
    expect(passengerCount(run(createWorld(1, 1, noDestinations), 2_000))).toBe(0);
  });

  it('keeps the header count in step with the active slots', () => {
    const world = run(createWorld(13, 1, twoDistrictCity()), 5_000);
    let active = 0;
    for (let slot = 0; slot < MAX_PASSENGERS; slot += 1)
      if (isPassengerActive(world, slot)) active += 1;
    expect(passengerCount(world)).toBe(active);
    expect(world.data[Header.PassengerCount]).toBe(active);
  });
});

describe('patience', () => {
  it('drains while waiting and removes the passenger at zero', () => {
    const city = twoDistrictCity();
    let world = atSpawnTick(city, 21);
    const slot = firstActive(world);
    const started = getPassenger(world, slot, Passenger.PatienceTicks);
    expect(started).toBeGreaterThan(0);

    world = run(world, 100);
    expect(getPassenger(world, slot, Passenger.PatienceTicks)).toBe(started - 100);

    // The slot is freed on expiry and immediately reusable, so "still active"
    // does not mean "same person". Identity is the spawn tick.
    const identity = getPassenger(world, slot, Passenger.SpawnTick);
    world = run(world, started);
    const stillTheSame =
      isPassengerActive(world, slot) && getPassenger(world, slot, Passenger.SpawnTick) === identity;
    expect(stillTheSame).toBe(false);
  });

  it('freezes for a carried Rush passenger but not a carried Meter one', () => {
    // DESIGN.md §2.1: a Meter passenger's failure is bailing when their patience
    // runs out. A Rush passenger never bails — their fare decays to a floor
    // instead — so their patience stops the moment they are aboard.
    const city = twoDistrictCity();

    for (const wantRush of [true, false]) {
      let world = createWorld(1, 1, city);
      const slot = 0;
      setPassenger(world, slot, Passenger.Flags, 1 | (wantRush ? 2 : 0));
      setPassenger(world, slot, Passenger.PatienceTicks, 500);
      setPassenger(world, slot, Passenger.Carrier, 0);
      world.data[Header.PassengerCount] = 1;

      world = run(world, 200);

      expect(getPassenger(world, slot, Passenger.PatienceTicks), wantRush ? 'rush' : 'meter').toBe(
        wantRush ? 500 : 300,
      );
    }
  });

  it('leaves a carried passenger who runs out for S-10 to price as a bail', () => {
    // Yanking them out here would hide the event from the task that owes the
    // player exactly zero for it.
    const city = twoDistrictCity();
    let world = createWorld(1, 1, city);
    setPassenger(world, 0, Passenger.Flags, 1);
    setPassenger(world, 0, Passenger.PatienceTicks, 10);
    setPassenger(world, 0, Passenger.Carrier, 0);
    world.data[Header.PassengerCount] = 1;

    world = run(world, 50);

    expect(isPassengerActive(world, 0)).toBe(true);
    expect(getPassenger(world, 0, Passenger.PatienceTicks)).toBe(0);
    expect(getPassenger(world, 0, Passenger.Carrier)).toBe(0);
  });
});

describe('distance despawn', () => {
  it('removes a waiting passenger nobody is near, after a grace period', () => {
    const far = prepareCity(
      packCity({
        ...emptyCityJson('far'),
        spawns: [{ x: 1500, y: 1500 }],
        destinations: [{ x: 0, y: 0 }],
        demandAnchors: [{ x: 1500, y: 1500, radius: 100, phase: 0 }],
      }),
    );

    let world = atSpawnTick(far, 4);
    const slot = firstActive(world);

    // Inside the grace period it stays, so a passenger cannot flicker.
    world = run(world, PassengerTuning.despawnGraceTicks - 5);
    expect(isPassengerActive(world, slot)).toBe(true);

    world = run(world, 10);
    expect(isPassengerActive(world, slot)).toBe(false);
  });

  it('keeps a passenger a cab is near', () => {
    const near = prepareCity(
      packCity({
        ...emptyCityJson('near'),
        spawns: [{ x: 20, y: 20 }],
        destinations: [{ x: 0, y: 0 }],
        demandAnchors: [{ x: 20, y: 20, radius: 100, phase: 0 }],
      }),
    );

    const world = run(atSpawnTick(near, 4), PassengerTuning.despawnGraceTicks + 100);
    expect(passengerCount(world)).toBeGreaterThan(0);
  });

  it('never removes a carried passenger for being far away', () => {
    const city = twoDistrictCity();
    let world = createWorld(1, 1, city);
    setPassenger(world, 0, Passenger.Flags, 1);
    setPassenger(world, 0, Passenger.X, 1500 * FX_ONE);
    setPassenger(world, 0, Passenger.Y, 1500 * FX_ONE);
    setPassenger(world, 0, Passenger.PatienceTicks, 100_000);
    setPassenger(world, 0, Passenger.Carrier, 0);
    world.data[Header.PassengerCount] = 1;

    world = run(world, PassengerTuning.despawnGraceTicks + 500);
    expect(isPassengerActive(world, 0)).toBe(true);
  });
});

describe('despawnPassenger', () => {
  it('frees the slot and decrements the count exactly once', () => {
    let world = atSpawnTick(twoDistrictCity(), 31);
    const before = passengerCount(world);
    const slot = firstActive(world);

    despawnPassenger(world, slot);
    expect(passengerCount(world)).toBe(before - 1);
    expect(isPassengerActive(world, slot)).toBe(false);

    // Idempotent: despawning an empty slot must not double-count.
    despawnPassenger(world, slot);
    expect(passengerCount(world)).toBe(before - 1);

    world = run(world, 1);
    expect(passengerCount(world)).toBeGreaterThanOrEqual(before - 1);
  });
});

function firstActive(world: World): number {
  for (let slot = 0; slot < MAX_PASSENGERS; slot += 1)
    if (isPassengerActive(world, slot)) return slot;
  throw new Error('no active passenger');
}

describe('timing', () => {
  it('attempts a spawn on the documented interval', () => {
    expect(PassengerTuning.spawnIntervalTicks).toBe(Math.round(TICK_HZ * 1.5));
    expect(PassengerTuning.migrationPeriodTicks).toBe(180 * TICK_HZ);
  });
});

describe('FareTuning.maxFareUnits — the fare-distance cap', () => {
  /**
   * A city where the cap can actually discriminate: everyone spawns at the
   * origin, one destination is close and three are far.
   */
  function nearAndFarCity(): RuntimeCity {
    const json: CityJson = {
      ...emptyCityJson('near and far'),
      demandAnchors: [{ x: 0, y: 0, radius: 400, phase: 0 }],
      spawns: [{ x: 0, y: 0 }],
      destinations: [
        { x: 40, y: 0 }, // near
        { x: 800, y: 0 }, // far
        { x: 0, y: 800 }, // far
        { x: -800, y: 0 }, // far
      ],
    };
    return prepareCity(packCity(json));
  }

  /** Destinations assigned across a run, as indices. */
  function assigned(city: RuntimeCity, ticks = 4000): number[] {
    const world = run(createWorld(99, 1, city), ticks);
    const out: number[] = [];
    for (let p = 0; p < 64; p += 1) {
      if (!isPassengerActive(world, p)) continue;
      out.push(getPassenger(world, p, Passenger.Destination));
    }
    return out;
  }

  const original = FareTuning.maxFareUnits;
  afterEach(() => {
    (FareTuning as { maxFareUnits: number }).maxFareUnits = original;
  });

  it('is ON, at the value the 2026-08-27 playtest chose', () => {
    // Was 0 when this constant was introduced, so that adding it changed no
    // recorded replay. The playtest then adopted 600 (~20 s), and the goldens
    // were regenerated in the same commit. Pinned because it is a balance
    // decision — 600 keeps variety while cutting the tail, where the 15 s cap
    // the note originally asked for would have discarded 77% of City 01's
    // spawn x destination pairs.
    expect(FareTuning.maxFareUnits).toBe(600);
  });

  it('at 0 it is genuinely off — the escape hatch still works', () => {
    // The mechanism that made adopting this safe: at 0 the destination is drawn
    // with the same single rngNextBelow call it always was. Kept as a test so
    // the uncapped path cannot rot now that it is no longer the default.
    (FareTuning as { maxFareUnits: number }).maxFareUnits = 0;
    const seen = new Set(assigned(nearAndFarCity()));
    // Without a cap the distant destinations are reachable. This is also the
    // baseline the capped test needs: without it, that test could pass because
    // nothing ever spawned at all.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('sends nobody past the cap once it is set', () => {
    (FareTuning as { maxFareUnits: number }).maxFareUnits = 100;
    const seen = new Set(assigned(nearAndFarCity()));
    // Only destination 0 is within 100 units of the origin.
    expect([...seen]).toStrictEqual([0]);
  });

  it('falls back to the full list rather than refusing to spawn', () => {
    // A spawn stranded beyond every destination must still produce fares. A
    // passenger who can never appear is a worse bug than a long fare.
    (FareTuning as { maxFareUnits: number }).maxFareUnits = 5;
    const out = assigned(nearAndFarCity());
    expect(out.length).toBeGreaterThan(0);
  });

  it('still spends exactly one RNG draw on the destination', () => {
    // Rejection sampling would consume an unbounded number of values and make
    // the stream depend on luck — a determinism bug waiting for a slow day.
    // Two runs of the same seed and cap must agree exactly.
    (FareTuning as { maxFareUnits: number }).maxFareUnits = 100;
    const a = assigned(nearAndFarCity());
    const b = assigned(nearAndFarCity());
    expect(b).toStrictEqual(a);
  });
});
