import { describe, expect, it } from 'vitest';

import { Input, packInput } from '@deadhead/proto';

import { CarTuning, carSpeed, carVelocityAngle } from '../src/car.js';
import { FX_ONE, TURN, fxAbs } from '../src/fx.js';
import { WORLD_MAX, WORLD_MIN } from '../src/constants.js';
import { Car, CarFlags, createWorld, getCar, hashWorld, type World } from '../src/world.js';
import { step } from '../src/step.js';

const THROTTLE = packInput(Input.Throttle);
const BRAKE = packInput(Input.Brake);

/** Drive one cab for `ticks`, with the input chosen per tick. */
function drive(inputAt: (tick: number) => number, ticks: number, seed = 1): World {
  let world = createWorld(seed, 1);
  for (let tick = 0; tick < ticks; tick += 1) world = step(world, [inputAt(tick)]);
  return world;
}

/** Signed angle between where the cab points and where it is going, in turn units. */
function slipAngle(world: World): number {
  const gap = (getCar(world, 0, Car.Heading) - carVelocityAngle(world, 0) + TURN / 2) & 0xffff;
  return gap - TURN / 2;
}

const isInt32 = (v: number): boolean => Object.is(v, v | 0);

// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces an identical hash after 10,000 ticks on two consecutive runs', () => {
    // S-06's done-when. The cross-engine half (node vs workerd) is S-14's
    // harness; this is the same log, run twice, in one engine.
    const log = (tick: number): number => {
      let input = 0;
      if (tick % 7 !== 0) input |= Input.Throttle;
      if (tick % 23 === 0) input |= Input.Brake;
      if (tick % 11 < 4) input |= Input.Left;
      if (tick % 17 < 5) input |= Input.Right;
      if (tick % 97 < 12) input |= Input.Handbrake;
      return input;
    };

    const first = drive(log, 10_000);
    const second = drive(log, 10_000);

    expect(hashWorld(second)).toBe(hashWorld(first));
    expect(Array.from(second.data)).toEqual(Array.from(first.data));
    // A log that never moved the car would pass the above trivially.
    expect(fxAbs(getCar(first, 0, Car.X)) + fxAbs(getCar(first, 0, Car.Y))).toBeGreaterThan(FX_ONE);
  });

  it('keeps every car field an exact int32 across a long chaotic run', () => {
    const world = drive((t) => (t * 37) & 0x3f, 5_000);
    for (const field of Object.values(Car)) {
      expect(isInt32(getCar(world, 0, field))).toBe(true);
    }
  });

  it('has a tuning table of exact int32s', () => {
    // Authored per second, stored per tick. A float here would leak into every
    // multiply the model does.
    for (const [name, value] of Object.entries(CarTuning)) {
      expect(isInt32(value), name).toBe(true);
    }
  });
});

describe('longitudinal', () => {
  it('accelerates under throttle and settles at the speed cap', () => {
    const early = drive(() => THROTTLE, 10);
    const settled = drive(() => THROTTLE, 600);

    expect(carSpeed(early, 0)).toBeGreaterThan(0);
    expect(carSpeed(settled, 0)).toBeGreaterThan(carSpeed(early, 0));
    expect(carSpeed(settled, 0)).toBeLessThanOrEqual(CarTuning.maxSpeed + 1);
  });

  it('coasts down and comes fully to rest rather than creeping', () => {
    // A truncating multiply can leave a car drifting at one unit per tick
    // forever, which looks like a haunted cab and never triggers "at rest"
    // logic downstream.
    const world = drive((t) => (t < 200 ? THROTTLE : 0), 3_000);
    expect(carSpeed(world, 0)).toBe(0);
    expect(getCar(world, 0, Car.VelocityX)).toBe(0);
    expect(getCar(world, 0, Car.VelocityY)).toBe(0);
  });

  it('reverses from rest under brake, and slower than it goes forward', () => {
    const reversing = drive(() => BRAKE, 400);
    expect(getCar(reversing, 0, Car.X)).toBeLessThan(0);
    expect(carSpeed(reversing, 0)).toBeLessThanOrEqual(CarTuning.maxReverseSpeed + 1);

    const forward = drive(() => THROTTLE, 400);
    expect(carSpeed(forward, 0)).toBeGreaterThan(carSpeed(reversing, 0));
  });

  it('brakes harder than it accelerates', () => {
    const cruising = drive(() => THROTTLE, 300);
    const braked = drive((t) => (t < 300 ? THROTTLE : BRAKE), 310);
    expect(carSpeed(braked, 0)).toBeLessThan(carSpeed(cruising, 0));
  });
});

describe('steering', () => {
  it('does not rotate a stationary car', () => {
    // The first thing every playtester tries. A cab pirouetting on the spot
    // reads as broken.
    const world = drive(() => packInput(Input.Right), 200);
    expect(getCar(world, 0, Car.Heading)).toBe(0);
    expect(getCar(world, 0, Car.X)).toBe(0);
    expect(getCar(world, 0, Car.Y)).toBe(0);
  });

  it('turns while moving', () => {
    const world = drive(() => packInput(Input.Throttle, Input.Right), 60);
    expect(getCar(world, 0, Car.Heading)).toBeGreaterThan(0);
  });

  it('mirrors exactly between left and right', () => {
    // Exact, not approximate: fxSin is odd and fxCos is even to the unit, so a
    // mirrored input must produce a mirrored world. Any asymmetry here is a
    // bug in the trig table or in the steering sign, and both would show up
    // later as a car that pulls to one side.
    const right = drive((t) => (t < 300 ? packInput(Input.Throttle, Input.Right) : 0), 400);
    const left = drive((t) => (t < 300 ? packInput(Input.Throttle, Input.Left) : 0), 400);

    expect(getCar(left, 0, Car.X)).toBe(getCar(right, 0, Car.X));
    expect(getCar(left, 0, Car.Y)).toBe(-getCar(right, 0, Car.Y));
    expect(getCar(left, 0, Car.Heading)).toBe(-getCar(right, 0, Car.Heading) & 0xffff);
  });

  it('steers the other way in reverse, as a real car does', () => {
    const forward = drive(() => packInput(Input.Throttle, Input.Right), 90);
    const reversing = drive(() => packInput(Input.Brake, Input.Right), 90);

    // Forward-right turns one way; reverse-right turns the other.
    const forwardTurn = ((getCar(forward, 0, Car.Heading) + TURN / 2) & 0xffff) - TURN / 2;
    const reverseTurn = ((getCar(reversing, 0, Car.Heading) + TURN / 2) & 0xffff) - TURN / 2;
    expect(Math.sign(forwardTurn)).toBe(-Math.sign(reverseTurn));
  });

  it('loses steering authority as speed rises', () => {
    // Same steering input, more speed, less turn per tick — otherwise the car
    // spins out at the top end.
    const slowTurn = drive((t) => (t < 6 ? THROTTLE : packInput(Input.Right)), 26);
    const fastTurn = drive((t) => (t < 300 ? THROTTLE : packInput(Input.Right)), 320);

    const perTick = (w: World, ticks: number): number =>
      (((getCar(w, 0, Car.Heading) + TURN / 2) & 0xffff) - TURN / 2) / ticks;

    expect(Math.abs(perTick(fastTurn, 20))).toBeLessThan(Math.abs(perTick(slowTurn, 20)) * 4);
  });
});

describe('drift', () => {
  it('tracks straight with no slip', () => {
    const world = drive(() => THROTTLE, 300);
    expect(slipAngle(world)).toBe(0);
    expect(getCar(world, 0, Car.Flags) & CarFlags.Drifting).toBe(0);
  });

  it('slides noticeably under handbrake and barely without it', () => {
    // The mechanic itself. The gap between where the cab points and where it is
    // going is what a player reads as drift, and C-08 renders it.
    const worstSlip = (inputAt: (t: number) => number): number => {
      let world = createWorld(1, 1);
      let worst = 0;
      for (let tick = 0; tick < 220; tick += 1) {
        world = step(world, [inputAt(tick)]);
        if (carSpeed(world, 0) > FX_ONE / 10) worst = Math.max(worst, Math.abs(slipAngle(world)));
      }
      return (worst / TURN) * 360;
    };

    const gripped = worstSlip((t) => (t < 100 ? THROTTLE : packInput(Input.Throttle, Input.Right)));
    const sliding = worstSlip((t) =>
      t < 100 ? THROTTLE : packInput(Input.Throttle, Input.Right, Input.Handbrake),
    );

    expect(gripped).toBeLessThan(10);
    expect(sliding).toBeGreaterThan(15);
    expect(sliding).toBeGreaterThan(gripped * 3);
  });

  it('raises the drift flag only while actually sliding', () => {
    let world = createWorld(1, 1);
    let flaggedWhileStraight = 0;
    let flaggedWhileSliding = 0;

    for (let tick = 0; tick < 260; tick += 1) {
      const sliding = tick >= 120;
      world = step(world, [
        sliding ? packInput(Input.Throttle, Input.Right, Input.Handbrake) : THROTTLE,
      ]);
      const flagged = (getCar(world, 0, Car.Flags) & CarFlags.Drifting) !== 0;
      if (flagged) {
        if (sliding) flaggedWhileSliding += 1;
        else flaggedWhileStraight += 1;
      }
    }

    expect(flaggedWhileStraight).toBe(0);
    expect(flaggedWhileSliding).toBeGreaterThan(30);
  });

  it('lets a drift carry the car past its forward speed cap', () => {
    // Documented rather than clamped. maxSpeed bounds the forward component;
    // total speed is the hypotenuse, so a big slide is worth a little extra
    // ground speed. That is a standard arcade-racer trade and C-08 gets to
    // decide whether it stays. It is flagged here so nobody "fixes" it by
    // accident, and so nobody is surprised when players find it.
    const drifting = drive(
      (t) => (t < 100 ? THROTTLE : packInput(Input.Throttle, Input.Right, Input.Handbrake)),
      180,
    );
    expect(carSpeed(drifting, 0)).toBeGreaterThan(CarTuning.maxSpeed);
    expect(carSpeed(drifting, 0)).toBeLessThan(CarTuning.maxSpeed * 2);
  });
});

describe('bounds', () => {
  it('never leaves the world, even driving at a wall for a long time', () => {
    // A placeholder until S-07 lands real collision, but the invariant is
    // permanent: a coordinate outside ±2048 is outside the fixed-point
    // envelope everything downstream assumes.
    const world = drive(() => THROTTLE, 20_000);
    for (const axis of [Car.X, Car.Y]) {
      expect(getCar(world, 0, axis)).toBeLessThanOrEqual(WORLD_MAX * FX_ONE);
      expect(getCar(world, 0, axis)).toBeGreaterThanOrEqual(WORLD_MIN * FX_ONE);
    }
  });
});

describe('isolation between cabs', () => {
  it('advances each slot from the same pre-step state', () => {
    // Slot order must not matter yet. It will once S-07 collision and M-08
    // contested pickup land, and both are specified to resolve by slot order
    // deterministically — but a car model that already leaked between slots
    // would make that impossible to reason about.
    let world = createWorld(1, 3);
    for (let tick = 0; tick < 200; tick += 1) {
      world = step(world, [THROTTLE, 0, packInput(Input.Throttle, Input.Right)]);
    }

    expect(getCar(world, 1, Car.X)).toBe(0);
    expect(getCar(world, 1, Car.VelocityX)).toBe(0);
    expect(getCar(world, 0, Car.Y)).toBe(0);
    expect(getCar(world, 2, Car.Y)).not.toBe(0);
  });

  it('gives identical cabs identical results regardless of slot', () => {
    let world = createWorld(1, 12);
    for (let tick = 0; tick < 300; tick += 1) {
      world = step(world, new Array(12).fill(packInput(Input.Throttle, Input.Right)));
    }
    for (let slot = 1; slot < 12; slot += 1) {
      expect(getCar(world, slot, Car.X)).toBe(getCar(world, 0, Car.X));
      expect(getCar(world, slot, Car.Heading)).toBe(getCar(world, 0, Car.Heading));
    }
  });
});
