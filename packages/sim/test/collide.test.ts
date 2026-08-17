import { describe, expect, it } from 'vitest';

import { Input, emptyCityJson, packCity, packInput } from '@deadhead/proto';

import { CarTuning } from '../src/car.js';
import {
  boxesFromUnits,
  buildStaticGeometry,
  emptyGeometry,
  overlapsStatic,
  sweepCar,
} from '../src/collide.js';
import { emptyCity, prepareCity, type RuntimeCity } from '../src/city.js';
import { FX_ONE, QUARTER_TURN, TURN, fxAbs, fxFromInt } from '../src/fx.js';
import { step } from '../src/step.js';
import {
  Car,
  CarFlags,
  createWorld,
  deserialize,
  getCar,
  getCityHash,
  hashWorld,
  rngOf,
  serialize,
  setCar,
  type World,
} from '../src/world.js';

/** Build a real city from whole-unit boxes, so tests exercise the W-01 path. */
function cityOf(...boxes: readonly (readonly number[])[]): RuntimeCity {
  return prepareCity(
    packCity({
      ...emptyCityJson('test'),
      buildings: boxes.map((b) => ({
        minX: b[0] as number,
        minY: b[1] as number,
        maxX: b[2] as number,
        maxY: b[3] as number,
      })),
    }),
  );
}

/** A single wall spanning x in [10, 40], y in [-2, 2]. */
const WALL_CITY = cityOf([10, -2, 40, 2]);
const WALL = WALL_CITY.statics;

const at = (x: number, y: number, heading = 0): boolean =>
  overlapsStatic(
    WALL,
    fxFromInt(x),
    fxFromInt(y),
    heading,
    CarTuning.halfLength,
    CarTuning.halfWidth,
  );

/** Place a cab and give it a velocity, then sweep it one tick. */
function sweepFrom(
  city: RuntimeCity,
  fromX: number,
  fromY: number,
  velocityX: number,
  velocityY: number,
  heading = 0,
): { world: World; hit: boolean; impact: number } {
  const world = createWorld(1, 1, city);
  const geometry = city.statics;
  setCar(world, 0, Car.X, fromX);
  setCar(world, 0, Car.Y, fromY);
  setCar(world, 0, Car.Heading, heading);
  setCar(world, 0, Car.VelocityX, velocityX);
  setCar(world, 0, Car.VelocityY, velocityY);
  setCar(world, 0, Car.X, fromX + velocityX);
  setCar(world, 0, Car.Y, fromY + velocityY);

  const result = sweepCar(world, 0, geometry, fromX, fromY);
  return { world, ...result };
}

// ---------------------------------------------------------------------------

describe('the spatial hash', () => {
  it('handles an empty city', () => {
    expect(overlapsStatic(emptyGeometry(), 0, 0, 0, FX_ONE, FX_ONE)).toBe(false);
  });

  it('finds a box wherever it sits, including across cell boundaries', () => {
    // A box straddling several cells must be reachable from every cell it
    // covers, or a cab clips through part of a long wall and not the rest.
    const long = buildStaticGeometry(boxesFromUnits([[-500, -1, 500, 1]]));
    for (let x = -480; x <= 480; x += 37) {
      expect(
        overlapsStatic(long, fxFromInt(x), 0, 0, CarTuning.halfLength, CarTuning.halfWidth),
      ).toBe(true);
    }
  });

  it('is not fooled by a box outside the queried cells', () => {
    const far = buildStaticGeometry(boxesFromUnits([[1000, 1000, 1010, 1010]]));
    expect(overlapsStatic(far, 0, 0, 0, CarTuning.halfLength, CarTuning.halfWidth)).toBe(false);
  });

  it('places every box in every cell it covers, exactly once', () => {
    const geometry = buildStaticGeometry(boxesFromUnits([[0, 0, 100, 100]]));
    const occurrences = Array.from(geometry.cellItems).filter((box) => box === 0).length;
    const cellsCovered = geometry.cellStart[geometry.cellStart.length - 1];
    expect(occurrences).toBe(cellsCovered);
    expect(occurrences).toBeGreaterThan(1);
  });
});

describe('narrowphase', () => {
  it('separates cleanly along both world axes', () => {
    expect(at(25, 0)).toBe(true);
    expect(at(25, 10)).toBe(false);
    expect(at(0, 0)).toBe(false);
    expect(at(60, 0)).toBe(false);
  });

  it('accounts for the cab being longer than it is wide', () => {
    // Nose-on the cab reaches further than side-on. A narrowphase that used one
    // radius for both would clip on one heading and float on the other.
    const noseOn = at(10 - 1, 0, 0);
    const sideOn = at(10 - 1, 0, QUARTER_TURN);
    expect(noseOn).toBe(true);
    expect(sideOn).toBe(false);
  });

  it('catches corner clipping that a two-axis test would get wrong', () => {
    // The classic failure, and the reason the SAT runs over four axes rather
    // than two. A cab at 45 degrees near a box corner projects onto BOTH world
    // axes overlapping the box — a two-axis test reports a collision — while
    // the cab's own axes correctly separate it.
    const corner = buildStaticGeometry(boxesFromUnits([[0, 0, 40, 40]]));
    const diagonal = TURN / 8;
    const place = (units: number): boolean =>
      overlapsStatic(
        corner,
        Math.round(units * FX_ONE),
        Math.round(units * FX_ONE),
        diagonal,
        CarTuning.halfLength,
        CarTuning.halfWidth,
      );

    // World-axis projection of the cab at 45 degrees, computed the way a
    // two-axis test would: it reaches past 0 on both axes from (-0.8, -0.8).
    const span = (CarTuning.halfLength + CarTuning.halfWidth) * Math.SQRT1_2;
    expect(-0.8 * FX_ONE + span).toBeGreaterThan(0);

    // ...and yet the cab is genuinely clear, because its nose stops short of
    // the corner along the diagonal.
    expect(place(-0.8)).toBe(false);

    // Closer in, it really does overlap.
    expect(place(-0.5)).toBe(true);
  });

  it('is symmetric under a half-turn of the cab', () => {
    // The cab is a symmetric box, so pointing it backwards cannot change
    // whether it overlaps. Exact, because fxSin is odd to the unit.
    for (let x = 5; x <= 45; x += 1) {
      for (const heading of [0, TURN / 8, QUARTER_TURN]) {
        expect(at(x, 0, heading)).toBe(at(x, 0, (heading + TURN / 2) & 0xffff));
      }
    }
  });
});

describe('the sweep', () => {
  it('does nothing when the path is clear', () => {
    const { world, hit } = sweepFrom(WALL_CITY, 0, fxFromInt(20), FX_ONE, 0);
    expect(hit).toBe(false);
    expect(getCar(world, 0, Car.X)).toBe(FX_ONE);
    expect(getCar(world, 0, Car.VelocityX)).toBe(FX_ONE);
  });

  it('stops a cab at the wall instead of inside it', () => {
    // Contact is at x = 8.95: the wall face is at 10 and the cab's half-length
    // is 1.1. Starting at 8 and moving a full unit crosses it.
    const { world, hit } = sweepFrom(WALL_CITY, fxFromInt(8), 0, FX_ONE, 0);
    expect(hit).toBe(true);
    expect(getCar(world, 0, Car.VelocityX)).toBe(0);
    expect(
      overlapsStatic(
        WALL,
        getCar(world, 0, Car.X),
        getCar(world, 0, Car.Y),
        0,
        CarTuning.halfLength,
        CarTuning.halfWidth,
      ),
    ).toBe(false);
  });

  it('refuses to tunnel through a wall at any speed', () => {
    // S-07's done-when. A single tick's move is subdivided so the cab can never
    // jump more than half its own width, so this holds even at speeds C-06's
    // sliders could reach — far beyond anything the current tuning produces.
    const thin = cityOf([20, -50, 21, 50]);
    for (const speed of [1, 4, 20, 100, 400]) {
      const { world, hit } = sweepFrom(thin, fxFromInt(18), 0, fxFromInt(speed), 0);
      expect(hit, `speed ${speed}`).toBe(true);
      expect(getCar(world, 0, Car.X), `speed ${speed}`).toBeLessThan(fxFromInt(20));
    }
  });

  it('slides along a wall rather than stopping dead', () => {
    // Axis-separated resolution. Driving into a wall at an angle should keep
    // the component parallel to it.
    // Side contact is at y = -2.5. Driving straight up into the wall stops the
    // Y component dead.
    const headOn = sweepFrom(WALL_CITY, fxFromInt(25), fxFromInt(-3), 0, FX_ONE);
    expect(headOn.hit).toBe(true);
    expect(getCar(headOn.world, 0, Car.VelocityY)).toBe(0);

    // Approaching at an angle keeps the component parallel to the wall. That
    // is what axis-separated resolution buys, and it is why a cab scrapes along
    // a building instead of sticking to it.
    const angled = sweepFrom(WALL_CITY, fxFromInt(25), fxFromInt(-3), FX_ONE, FX_ONE);
    expect(angled.hit).toBe(true);
    expect(getCar(angled.world, 0, Car.VelocityY)).toBe(0);
    expect(getCar(angled.world, 0, Car.VelocityX)).toBe(FX_ONE);
    expect(getCar(angled.world, 0, Car.X)).toBeGreaterThan(fxFromInt(25));
  });

  it('lets a cab rest against a wall without jittering', () => {
    // The third of S-07's named hazards, and the one that reads worst in play.
    // Held against a wall under throttle, the cab must land on the same
    // position every tick — not buzz between two.
    let world = createWorld(1, 1, WALL_CITY);
    setCar(world, 0, Car.X, fxFromInt(5));
    setCar(world, 0, Car.Y, 0);

    const positions: number[] = [];
    for (let tick = 0; tick < 120; tick += 1) {
      world = step(world, [packInput(Input.Throttle)]);
      if (tick >= 60) positions.push(getCar(world, 0, Car.X));
    }

    expect(new Set(positions).size).toBe(1);
    expect(getCar(world, 0, Car.VelocityX)).toBe(0);
  });

  it('reports a hard impact as a crash and a scrape as neither', () => {
    const hard = sweepFrom(WALL_CITY, fxFromInt(8), 0, CarTuning.maxSpeed, 0);
    expect(hard.impact).toBeGreaterThanOrEqual(CarTuning.crashImpact);
    expect(getCar(hard.world, 0, Car.Flags) & CarFlags.Crashed).toBeTruthy();

    const gentle = sweepFrom(WALL_CITY, Math.round(8.9 * FX_ONE), 0, FX_ONE / 8, 0);
    expect(gentle.impact).toBeLessThan(CarTuning.crashImpact);
    expect(getCar(gentle.world, 0, Car.Flags) & CarFlags.Crashed).toBe(0);
  });
});

describe('determinism with geometry attached', () => {
  it('produces an identical hash over 5,000 ticks against a city', () => {
    const city = cityOf([10, -2, 40, 2], [-40, 10, -10, 14], [-5, -30, 5, -20], [50, 50, 90, 90]);

    const run = (): World => {
      let world = createWorld(0xc17e, 1, city);
      for (let tick = 0; tick < 5_000; tick += 1) {
        let input = packInput(Input.Throttle);
        if (tick % 13 < 5) input |= Input.Right;
        if (tick % 29 < 4) input |= Input.Left;
        if (tick % 61 < 8) input |= Input.Handbrake;
        world = step(world, [input]);
      }
      return world;
    };

    expect(hashWorld(run())).toBe(hashWorld(run()));
  });

  it('keeps the city out of the serialised bytes, because it is input not state', () => {
    // ADR 0004. A world serialises to the same size whatever city it is played
    // on, and deserialize cannot restore the city — the caller reattaches it,
    // with Header.CityHash to check against.
    const big = cityOf([0, 0, 10, 10], [20, 20, 30, 30], [-40, -40, -30, -30]);
    const world = createWorld(7, 1, big);

    expect(serialize(world).byteLength).toBe(serialize(createWorld(7, 1, emptyCity())).byteLength);
    expect(deserialize(serialize(world)).city).toBeUndefined();
    expect(getCityHash(deserialize(serialize(world)))).toBe(big.packed.contentHash);
  });

  it('folds the city hash into the run seed, so a different city is a different run', () => {
    // ADR 0005, and the inverse of what one might expect: the city's geometry
    // is not hashed, but its CONTENT HASH is folded into the seed. So the same
    // numeric seed on a different city is a different stream — which is what
    // makes a city edit invalidate old leaderboard entries rather than silently
    // rescore them against geometry that has moved.
    const a = createWorld(7, 1, cityOf([0, 0, 10, 10]));
    const b = createWorld(7, 1, cityOf([0, 0, 10, 11]));

    expect(a.city?.packed.contentHash).not.toBe(b.city?.packed.contentHash);
    expect(Array.from(rngOf(a))).not.toEqual(Array.from(rngOf(b)));
    expect(hashWorld(a)).not.toBe(hashWorld(b));

    // The same city is still perfectly reproducible.
    expect(hashWorld(createWorld(7, 1, cityOf([0, 0, 10, 10])))).toBe(hashWorld(a));
  });

  it('shares geometry by reference across a copy', () => {
    // Copying a city's worth of boxes 30 times a second would be absurd, and
    // it never changes during a run.
    const world = createWorld(1, 1, WALL_CITY);
    const next = step(world, [0]);
    expect(next.city).toBe(world.city);
    expect(next.city?.statics).toBe(world.city?.statics);
  });

  it('never leaves a cab overlapping the city', () => {
    const city = cityOf([6, -6, 12, 6], [20, -20, 30, 20]);
    let world = createWorld(3, 1, city);
    for (let tick = 0; tick < 2_000; tick += 1) {
      world = step(world, [packInput(Input.Throttle, tick % 7 < 3 ? Input.Right : Input.Left)]);
      const overlapping = overlapsStatic(
        city.statics,
        getCar(world, 0, Car.X),
        getCar(world, 0, Car.Y),
        getCar(world, 0, Car.Heading) & 0xffff,
        CarTuning.halfLength,
        CarTuning.halfWidth,
      );
      expect(overlapping, `tick ${tick}`).toBe(false);
    }
  });
});

describe('the arithmetic envelope', () => {
  it('keeps narrowphase offsets far inside the squarable bound', () => {
    // ADR 0003: multiplying an absolute coordinate would overflow. The
    // narrowphase only ever multiplies a *relative* offset, and that offset is
    // only small because the broadphase already discarded distant boxes.
    // Verified at the far corner of the world, where absolute coordinates are
    // 32x past the bound.
    const corner = cityOf([2000, 2000, 2040, 2040]).statics;
    expect(
      overlapsStatic(
        corner,
        fxFromInt(2020),
        fxFromInt(2020),
        TURN / 8,
        CarTuning.halfLength,
        CarTuning.halfWidth,
      ),
    ).toBe(true);
    expect(
      overlapsStatic(
        corner,
        fxFromInt(1900),
        fxFromInt(1900),
        TURN / 8,
        CarTuning.halfLength,
        CarTuning.halfWidth,
      ),
    ).toBe(false);
  });

  it('leaves every car field an exact int32 after collisions', () => {
    let world = createWorld(9, 1, WALL_CITY);
    for (let tick = 0; tick < 1_000; tick += 1) {
      world = step(world, [packInput(Input.Throttle, Input.Right)]);
    }
    for (const field of Object.values(Car)) {
      const value = getCar(world, 0, field);
      expect(Object.is(value, value | 0), String(field)).toBe(true);
      expect(fxAbs(value)).toBeLessThanOrEqual(0x7fffffff);
    }
  });
});
