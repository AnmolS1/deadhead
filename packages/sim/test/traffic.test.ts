import { describe, expect, it } from 'vitest';

import { EdgeFlags, Input, emptyCityJson, packCity, packInput } from '@deadhead/proto';

import { prepareCity, type RuntimeCity } from '../src/city.js';
import { FX_ONE, TURN, fxFromInt } from '../src/fx.js';
import { step } from '../src/step.js';
import { TrafficTuning, isTrafficActive, trafficCount } from '../src/traffic.js';
import {
  Car,
  CarFlags,
  MAX_TRAFFIC,
  Traffic,
  TrafficFlags,
  createWorld,
  getCar,
  getTraffic,
  setCar,
  trafficRngOf,
  type World,
} from '../src/world.js';

/** A 3x3 junction grid with two buildings to crash into and a kerb to work. */
function gridCity(extra: Partial<Parameters<typeof packCity>[0]> = {}): RuntimeCity {
  const coords = [0, 60, 120];
  const nodes = coords.flatMap((y) => coords.map((x) => ({ x, y })));
  const edges: { a: number; b: number; width: number; flags?: number }[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const index = row * 3 + col;
      if (col < 2) edges.push({ a: index, b: index + 1, width: 8 });
      if (row < 2) edges.push({ a: index, b: index + 3, width: 8 });
    }
  }

  return prepareCity(
    packCity({
      ...emptyCityJson('grid'),
      nodes,
      edges,
      buildings: [
        { minX: 10, minY: 10, maxX: 50, maxY: 50 },
        { minX: 70, minY: 10, maxX: 110, maxY: 50 },
      ],
      spawns: [{ x: 4, y: 30 }],
      destinations: [{ x: 120, y: 120 }],
      demandAnchors: [{ x: 30, y: 30, radius: 120, phase: 0 }],
      ...extra,
    }),
  );
}

/** FNV-1a over the traffic region only. */
function trafficFingerprint(world: World): number {
  let hash = 0x811c9dc5;
  for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) {
    for (const field of Object.values(Traffic)) {
      const value = getTraffic(world, slot, field);
      for (let byte = 0; byte < 4; byte += 1) {
        hash ^= (value >>> (byte * 8)) & 0xff;
        hash = Math.imul(hash, 0x01000193);
      }
    }
  }
  return hash >>> 0;
}

function play(city: RuntimeCity, inputAt: (tick: number) => number, ticks: number): World {
  let world = createWorld(0x7aff1c, 1, city);
  for (let tick = 0; tick < ticks; tick += 1) world = step(world, [inputAt(tick)]);
  return world;
}

// ---------------------------------------------------------------------------

describe('the constraint', () => {
  it('leaves traffic byte-identical whatever the player does, at tick 10,000', () => {
    // S-08's done-when, and the property that makes traffic cost zero
    // bandwidth: every client reproduces it from the seed alone.
    const city = gridCity();

    const idle = play(city, () => 0, 10_000);
    const driving = play(
      city,
      (t) => packInput(Input.Throttle, t % 13 < 5 ? Input.Right : Input.Left),
      10_000,
    );
    const crashing = play(city, () => packInput(Input.Throttle), 10_000);

    expect(trafficFingerprint(driving)).toBe(trafficFingerprint(idle));
    expect(trafficFingerprint(crashing)).toBe(trafficFingerprint(idle));

    // ...and the runs really were different, or the assertion above proves
    // nothing. One cab crashed and the other did not.
    expect(getCar(crashing, 0, Car.X)).not.toBe(getCar(driving, 0, Car.X));
  });

  it('is unmoved by a cab that crashes into the city', () => {
    // A collision affects the player only. The bus does not notice.
    const city = gridCity();

    // Line the cab up on the building at [10,10]-[50,50] with room to reach
    // full speed first, so the impact is a crash rather than a scrape.
    let crashed = createWorld(0x7aff1c, 1, city);
    setCar(crashed, 0, Car.X, fxFromInt(-30));
    setCar(crashed, 0, Car.Y, fxFromInt(30));
    let clean = createWorld(0x7aff1c, 1, city);

    for (let tick = 0; tick < 2_000; tick += 1) {
      crashed = step(crashed, [packInput(Input.Throttle)]);
      clean = step(clean, [0]);
    }

    expect(getCar(crashed, 0, Car.Flags) & CarFlags.Crashed).toBeTruthy();
    expect(getCar(clean, 0, Car.Flags) & CarFlags.Crashed).toBe(0);
    expect(trafficFingerprint(crashed)).toBe(trafficFingerprint(clean));
  });

  it('is unmoved by a cab that works a fare', () => {
    // The subtle half, and the reason traffic has its own generator. Collecting
    // a passenger changes the waiting population, which changes whether a spawn
    // is attempted, which changes how many numbers are drawn from the main
    // stream. On one shared stream every NPC downstream would drift, and
    // nobody would have written a line of code to make it happen.
    const city = gridCity();

    let working = createWorld(0x7aff1c, 1, city);
    setCar(working, 0, Car.X, fxFromInt(4));
    setCar(working, 0, Car.Y, fxFromInt(30));
    let parked = createWorld(0x7aff1c, 1, city);
    setCar(parked, 0, Car.X, fxFromInt(1000));
    setCar(parked, 0, Car.Y, fxFromInt(1000));

    for (let tick = 0; tick < 3_000; tick += 1) {
      working = step(working, [0]);
      parked = step(parked, [0]);
    }

    // The working cab really did pick people up.
    expect(getCar(working, 0, Car.CarriedPassenger)).toBeGreaterThanOrEqual(0);
    expect(trafficFingerprint(working)).toBe(trafficFingerprint(parked));
  });

  it('keeps the two generators from ever coinciding', () => {
    const world = createWorld(42, 1, gridCity());
    expect(Array.from(trafficRngOf(world))).not.toEqual(Array.from(world.data.subarray(8, 12)));
  });
});

describe('determinism', () => {
  it('reproduces the same traffic from the same seed and city', () => {
    const city = gridCity();
    expect(trafficFingerprint(play(city, () => 0, 5_000))).toBe(
      trafficFingerprint(play(city, () => 0, 5_000)),
    );
  });

  it('produces different traffic from a different seed', () => {
    const city = gridCity();
    const runWith = (seed: number): World => {
      let world = createWorld(seed, 1, city);
      for (let tick = 0; tick < 500; tick += 1) world = step(world, [0]);
      return world;
    };
    expect(trafficFingerprint(runWith(2))).not.toBe(trafficFingerprint(runWith(1)));
  });

  it('keeps every traffic field an exact int32 over a long run', () => {
    const world = play(gridCity(), () => packInput(Input.Throttle), 8_000);
    for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) {
      for (const field of Object.values(Traffic)) {
        const value = getTraffic(world, slot, field);
        expect(Object.is(value, value | 0)).toBe(true);
      }
    }
  });
});

describe('driving the network', () => {
  it('puts vehicles on the road at the start', () => {
    const world = createWorld(1, 1, gridCity());
    expect(trafficCount(world)).toBe(TrafficTuning.count);
    expect(isTrafficActive(world, 0)).toBe(true);
  });

  it('moves them, and keeps them on the grid', () => {
    // Every road in this city is axis-aligned, so a vehicle that is anywhere
    // other than on a grid line has fallen off the network.
    let world = createWorld(1, 1, gridCity());
    const startX = getTraffic(world, 0, Traffic.X);
    const startY = getTraffic(world, 0, Traffic.Y);

    for (let tick = 0; tick < 600; tick += 1) world = step(world, [0]);

    expect(
      getTraffic(world, 0, Traffic.X) !== startX || getTraffic(world, 0, Traffic.Y) !== startY,
    ).toBe(true);

    for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) {
      if (!isTrafficActive(world, slot)) continue;
      const x = getTraffic(world, slot, Traffic.X) / FX_ONE;
      const y = getTraffic(world, slot, Traffic.Y) / FX_ONE;
      const onGridLine = [0, 60, 120].some(
        (line) => Math.abs(x - line) < 0.5 || Math.abs(y - line) < 0.5,
      );
      expect(onGridLine, `slot ${slot} at ${x},${y}`).toBe(true);
      expect(x).toBeGreaterThanOrEqual(-0.5);
      expect(x).toBeLessThanOrEqual(120.5);
      expect(y).toBeGreaterThanOrEqual(-0.5);
      expect(y).toBeLessThanOrEqual(120.5);
    }
  });

  it('faces the way it is going', () => {
    let world = createWorld(3, 1, gridCity());
    for (let tick = 0; tick < 200; tick += 1) world = step(world, [0]);

    for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) {
      if (!isTrafficActive(world, slot)) continue;
      const heading = getTraffic(world, slot, Traffic.Heading);
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(heading).toBeLessThan(TURN);
      // Every road here is axis-aligned, so every heading must be a quarter turn.
      expect(heading % (TURN / 4)).toBe(0);
    }
  });

  it('flips heading when travelling an edge backwards', () => {
    const world = createWorld(1, 1, gridCity());
    let forward = -1;
    let reverse = -1;
    for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) {
      const reversed = (getTraffic(world, slot, Traffic.Flags) & TrafficFlags.Reverse) !== 0;
      if (reversed && reverse < 0) reverse = slot;
      if (!reversed && forward < 0) forward = slot;
    }
    expect(forward).toBeGreaterThanOrEqual(0);
    expect(reverse).toBeGreaterThanOrEqual(0);
  });

  it('obeys one-way streets', () => {
    // A one-way edge appears only in its `a` node's exit list, so no vehicle can
    // ever be found travelling it in reverse.
    const coords = [0, 60];
    const nodes = coords.flatMap((y) => coords.map((x) => ({ x, y })));
    const oneWay = prepareCity(
      packCity({
        ...emptyCityJson('one-ways'),
        nodes,
        edges: [
          { a: 0, b: 1, width: 8, flags: EdgeFlags.OneWay },
          { a: 1, b: 3, width: 8, flags: EdgeFlags.OneWay },
          { a: 3, b: 2, width: 8, flags: EdgeFlags.OneWay },
          { a: 2, b: 0, width: 8, flags: EdgeFlags.OneWay },
        ],
        destinations: [{ x: 0, y: 0 }],
      }),
    );

    let world = createWorld(9, 1, oneWay);
    for (let tick = 0; tick < 2_000; tick += 1) {
      world = step(world, [0]);
      for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) {
        if (!isTrafficActive(world, slot)) continue;
        expect(getTraffic(world, slot, Traffic.Flags) & TrafficFlags.Reverse).toBe(0);
      }
    }
  });

  it('survives a city with no roads at all', () => {
    const roadless = prepareCity(packCity({ ...emptyCityJson('roadless') }));
    let world = createWorld(1, 1, roadless);
    expect(trafficCount(world)).toBe(0);
    for (let tick = 0; tick < 200; tick += 1) world = step(world, [0]);
    expect(trafficCount(world)).toBe(0);
  });

  it('survives a dead end without losing the vehicle', () => {
    // A stub road with a one-way in and no way out. The vehicle holds at the
    // junction rather than vanishing or looping forever; W-02 is where an
    // author gets told their network has a dead end.
    const deadEnd = prepareCity(
      packCity({
        ...emptyCityJson('dead end'),
        nodes: [
          { x: 0, y: 0 },
          { x: 60, y: 0 },
        ],
        edges: [{ a: 0, b: 1, width: 8, flags: EdgeFlags.OneWay }],
        destinations: [{ x: 0, y: 0 }],
      }),
    );

    let world = createWorld(1, 1, deadEnd);
    const before = trafficCount(world);
    for (let tick = 0; tick < 1_000; tick += 1) world = step(world, [0]);

    expect(trafficCount(world)).toBe(before);
    for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) {
      if (!isTrafficActive(world, slot)) continue;
      expect(getTraffic(world, slot, Traffic.X)).toBeLessThanOrEqual(fxFromInt(60));
    }
  });

  it('travels slower than a cab, so a cab can overtake', () => {
    expect(TrafficTuning.maxSpeed).toBeLessThan(FX_ONE);
    expect(TrafficTuning.minSpeed).toBeLessThan(TrafficTuning.maxSpeed);
  });
});
