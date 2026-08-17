import { describe, expect, it } from 'vitest';

import { emptyCityJson, packCity } from '@deadhead/proto';

import { prepareCity, type RuntimeCity } from '../src/city.js';
import { ClockTuning } from '../src/clock.js';
import { WORLD_MAX } from '../src/constants.js';
import { FareTuning, fareValue, withinRadius } from '../src/fare.js';
import { FX_ONE, fxFromInt } from '../src/fx.js';
import { isPassengerActive, isRush, passengerCount } from '../src/passengers.js';
import { step } from '../src/step.js';
import {
  Car,
  CarFlags,
  Header,
  MAX_PASSENGERS,
  NO_CARRIER,
  NO_PASSENGER,
  Passenger,
  PassengerFlags,
  createWorld,
  getCar,
  getPassenger,
  hashWorld,
  setCar,
  setPassenger,
  type World,
} from '../src/world.js';

/**
 * A city with a destination but **no spawn points**, for tests that stage a
 * passenger by hand.
 *
 * Without this a parked cab keeps collecting whoever the spawn schedule puts on
 * the kerb it is sitting on, which is correct behaviour and completely wrecks a
 * test trying to observe one specific fare.
 */
function stagedCity(): RuntimeCity {
  return prepareCity(
    packCity({
      ...emptyCityJson('staged'),
      destinations: [{ x: 100, y: 0 }],
    }),
  );
}

/** One kerb, one destination 100 units away. Used by the end-to-end test. */
function simpleCity(): RuntimeCity {
  return prepareCity(
    packCity({
      ...emptyCityJson('one fare'),
      spawns: [{ x: 0, y: 0 }],
      destinations: [{ x: 100, y: 0 }],
      demandAnchors: [{ x: 0, y: 0, radius: 50, phase: 0 }],
    }),
  );
}

/**
 * Put a passenger of a chosen class in slot 0 and a stopped cab beside them,
 * bypassing the spawn schedule so payout curves can be pinned exactly.
 */
function stagedFare(rush: boolean, patience = 100_000): World {
  const world = createWorld(1, 1, stagedCity());
  setPassenger(world, 0, Passenger.Flags, PassengerFlags.Active | (rush ? PassengerFlags.Rush : 0));
  setPassenger(world, 0, Passenger.X, 0);
  setPassenger(world, 0, Passenger.Y, 0);
  setPassenger(world, 0, Passenger.Destination, 0);
  setPassenger(world, 0, Passenger.PatienceTicks, patience);
  setPassenger(world, 0, Passenger.Carrier, NO_CARRIER);
  world.data[Header.PassengerCount] = 1;
  return world;
}

const run = (world: World, ticks: number): World => {
  let current = world;
  for (let i = 0; i < ticks; i += 1) current = step(current, [0]);
  return current;
};

/** Teleport the cab, standing in for driving there. */
function moveCab(world: World, x: number, y: number): World {
  setCar(world, 0, Car.X, fxFromInt(x));
  setCar(world, 0, Car.Y, fxFromInt(y));
  return world;
}

// ---------------------------------------------------------------------------

describe('the payout curves', () => {
  it('pins a Meter fare at start, middle and ceiling', () => {
    // S-10's done-when. A Meter fare GROWS, which is what makes the scenic
    // route a strategy rather than a mistake (DESIGN.md §2.1).
    const world = run(stagedFare(false), 1);
    expect(getCar(world, 0, Car.CarriedPassenger)).toBe(0);

    const at = (ticks: number): number => {
      setCar(world, 0, Car.FareTicks, ticks);
      return fareValue(world, 0);
    };

    expect(at(0)).toBe(FareTuning.meterBase);
    expect(at(300)).toBe(FareTuning.meterBase + FareTuning.meterPerTick * 300);
    expect(at(1_800)).toBe(
      Math.min(FareTuning.meterMax, FareTuning.meterBase + FareTuning.meterPerTick * 1_800),
    );
    // The ceiling holds, so an endless ride is not an endless score.
    expect(at(1_000_000)).toBe(FareTuning.meterMax);
  });

  it('pins a Rush fare at start, middle and floor', () => {
    // A Rush fare DECAYS to a non-zero floor. Their failure mode is a poor
    // fare, not a lost one — only a Meter bail pays nothing.
    const world = run(stagedFare(true), 1);
    expect(isRush(world, 0)).toBe(true);

    const at = (ticks: number): number => {
      setCar(world, 0, Car.FareTicks, ticks);
      return fareValue(world, 0);
    };

    expect(at(0)).toBe(FareTuning.rushMax);
    expect(at(300)).toBe(FareTuning.rushMax - FareTuning.rushDecayPerTick * 300);
    expect(at(1_000_000)).toBe(FareTuning.rushFloor);
    expect(FareTuning.rushFloor).toBeGreaterThan(0);
  });

  it('moves the two classes in opposite directions', () => {
    // The entire point of having two. If these ever agreed in sign, the
    // decision on the corner would stop existing.
    const meter = run(stagedFare(false), 1);
    const rush = run(stagedFare(true), 1);

    const curve = (world: World): number[] =>
      [0, 200, 400, 600].map((ticks) => {
        setCar(world, 0, Car.FareTicks, ticks);
        return fareValue(world, 0);
      });

    const meterCurve = curve(meter);
    const rushCurve = curve(rush);
    for (let i = 1; i < meterCurve.length; i += 1) {
      expect(meterCurve[i]).toBeGreaterThan(meterCurve[i - 1] as number);
      expect(rushCurve[i]).toBeLessThan(rushCurve[i - 1] as number);
    }
  });

  it('is zero for an empty cab', () => {
    expect(fareValue(createWorld(1, 1, stagedCity()), 0)).toBe(0);
  });
});

describe('the bail path', () => {
  it('pays exactly zero — no cash, no delivery, no deadhead back', () => {
    // S-10's other done-when. DESIGN.md §2.1: patience empties, they bail, you
    // get nothing. "Nothing" has to mean all three.
    let world = run(stagedFare(false, 40), 1);
    expect(getCar(world, 0, Car.CarriedPassenger)).toBe(0);

    const deadheadBefore = getCar(world, 0, Car.DeadheadTicks);
    world = run(world, 60);

    expect(getCar(world, 0, Car.Cash)).toBe(0);
    expect(getCar(world, 0, Car.Deliveries)).toBe(0);
    expect(getCar(world, 0, Car.CarriedPassenger)).toBe(NO_PASSENGER);
    // The clock resumed the tick the cab emptied, and gained nothing.
    expect(getCar(world, 0, Car.DeadheadTicks)).toBeLessThan(deadheadBefore);
    expect(getCar(world, 0, Car.DeadheadTicks)).toBeLessThan(
      deadheadBefore + ClockTuning.deliveryBonusTicks,
    );
  });

  it('removes the passenger rather than leaving them in the cab', () => {
    let world = run(stagedFare(false, 20), 1);
    world = run(world, 40);
    expect(isPassengerActive(world, 0)).toBe(false);
    expect(passengerCount(world)).toBe(0);
  });

  it('never bails a Rush passenger, however long the ride', () => {
    // The floor is reached at (rushMax - rushFloor) / decay = 700 ticks, so run
    // well past it — and well past the 30 ticks of patience they started with.
    let world = run(stagedFare(true, 30), 1);
    world = run(world, 900);

    expect(getCar(world, 0, Car.CarriedPassenger)).toBe(0);
    expect(getCar(world, 0, Car.Cash)).toBe(0);
    expect(fareValue(world, 0)).toBe(FareTuning.rushFloor);
  });
});

describe('pickup', () => {
  it('requires the cab to be stopped', () => {
    const moving = stagedFare(false);
    setCar(moving, 0, Car.VelocityX, FX_ONE);
    expect(getCar(run(moving, 1), 0, Car.CarriedPassenger)).toBe(NO_PASSENGER);

    const crawling = stagedFare(false);
    setCar(crawling, 0, Car.VelocityX, FareTuning.stoppedSpeed / 2);
    expect(getCar(run(crawling, 1), 0, Car.CarriedPassenger)).toBe(0);
  });

  it('requires the cab to be close', () => {
    const far = moveCab(stagedFare(false), 40, 0);
    expect(getCar(run(far, 1), 0, Car.CarriedPassenger)).toBe(NO_PASSENGER);

    const near = stagedFare(false);
    expect(getCar(run(near, 1), 0, Car.CarriedPassenger)).toBe(0);
  });

  it('marks the passenger as claimed', () => {
    const world = run(stagedFare(false), 1);
    expect(getPassenger(world, 0, Passenger.Carrier)).toBe(0);
  });

  it('will not collect a second passenger while carrying one', () => {
    const world = stagedFare(false);
    setPassenger(world, 1, Passenger.Flags, PassengerFlags.Active);
    setPassenger(world, 1, Passenger.PatienceTicks, 10_000);
    setPassenger(world, 1, Passenger.Carrier, NO_CARRIER);
    world.data[Header.PassengerCount] = 2;

    const after = run(world, 5);
    expect(getCar(after, 0, Car.CarriedPassenger)).toBe(0);
    expect(getPassenger(after, 1, Passenger.Carrier)).toBe(NO_CARRIER);
  });

  it('will not let an eliminated cab collect anyone', () => {
    const world = stagedFare(false);
    setCar(world, 0, Car.Flags, getCar(world, 0, Car.Flags) | CarFlags.Eliminated);
    expect(getCar(run(world, 1), 0, Car.CarriedPassenger)).toBe(NO_PASSENGER);
  });

  it('resolves a contest by cab slot, deterministically', () => {
    // M-08 replaces this with a hail lock so contests turn on positioning and
    // braking rather than a frame race. Until then it must at least be stable:
    // two clients must never disagree about who got there first.
    const build = (): World => {
      const world = createWorld(1, 2, stagedCity());
      setPassenger(world, 0, Passenger.Flags, PassengerFlags.Active);
      setPassenger(world, 0, Passenger.PatienceTicks, 10_000);
      setPassenger(world, 0, Passenger.Carrier, NO_CARRIER);
      world.data[Header.PassengerCount] = 1;
      return world;
    };

    const first = step(build(), [0, 0]);
    const second = step(build(), [0, 0]);

    expect(getCar(first, 0, Car.CarriedPassenger)).toBe(0);
    expect(getCar(first, 1, Car.CarriedPassenger)).toBe(NO_PASSENGER);
    expect(hashWorld(second)).toBe(hashWorld(first));
  });
});

describe('drop-off', () => {
  it('pays out, counts the delivery and clears the cab', () => {
    let world = run(stagedFare(false), 1);
    world = run(world, 200);
    const owed = fareValue(world, 0);

    world = run(moveCab(world, 100, 0), 1);

    expect(getCar(world, 0, Car.Cash)).toBe(owed);
    expect(getCar(world, 0, Car.Deliveries)).toBe(1);
    expect(getCar(world, 0, Car.CarriedPassenger)).toBe(NO_PASSENGER);
    expect(isPassengerActive(world, 0)).toBe(false);
  });

  it('requires being at the destination, not merely somewhere', () => {
    let world = run(stagedFare(false), 1);
    world = run(moveCab(world, 60, 0), 5);
    expect(getCar(world, 0, Car.Deliveries)).toBe(0);
    expect(getCar(world, 0, Car.CarriedPassenger)).toBe(0);
  });

  it('requires stopping at the destination', () => {
    let world = run(stagedFare(false), 1);
    world = moveCab(world, 100, 0);
    setCar(world, 0, Car.VelocityX, FX_ONE);
    world = step(world, [0]);
    expect(getCar(world, 0, Car.Deliveries)).toBe(0);
  });

  it('accumulates cash across several fares', () => {
    let world = run(stagedFare(false), 1);
    world = run(world, 100);
    const firstFare = fareValue(world, 0);
    world = run(moveCab(world, 100, 0), 1);
    expect(getCar(world, 0, Car.Cash)).toBe(firstFare);

    // Stage a second passenger at the cab's new position.
    setPassenger(world, 1, Passenger.Flags, PassengerFlags.Active);
    setPassenger(world, 1, Passenger.X, fxFromInt(100));
    setPassenger(world, 1, Passenger.Y, 0);
    setPassenger(world, 1, Passenger.Destination, 0);
    setPassenger(world, 1, Passenger.PatienceTicks, 10_000);
    setPassenger(world, 1, Passenger.Carrier, NO_CARRIER);
    world.data[Header.PassengerCount] = passengerCount(world) + 1;

    world = run(world, 1);
    expect(getCar(world, 0, Car.CarriedPassenger)).toBe(1);

    // Drive away before running the meter. Their destination is the corner they
    // were standing on, so staying put would deliver them the instant they got
    // in — correct behaviour, and not what this test is measuring.
    world = run(moveCab(world, 0, 0), 50);
    const secondFare = fareValue(world, 0);
    world = run(moveCab(world, 100, 0), 1);

    expect(getCar(world, 0, Car.Cash)).toBe(firstFare + secondFare);
    expect(getCar(world, 0, Car.Deliveries)).toBe(2);
  });
});

describe('the whole loop', () => {
  it('spawns, collects, carries and pays — with the clock frozen throughout', () => {
    // The game, in one test. Every subsystem from S-04 through S-11 has to
    // agree for this to pass.
    let world = createWorld(0xfa8e, 1, simpleCity());
    let pickedAt = -1;
    let bankAtPickup = 0;

    for (let tick = 0; tick < 400; tick += 1) {
      world = step(world, [0]);
      if (pickedAt < 0 && getCar(world, 0, Car.CarriedPassenger) !== NO_PASSENGER) {
        pickedAt = tick;
        bankAtPickup = getCar(world, 0, Car.DeadheadTicks);
      }
      if (pickedAt >= 0 && tick === pickedAt + 200) world = moveCab(world, 100, 0);
      if (getCar(world, 0, Car.Deliveries) > 0) break;
    }

    expect(pickedAt).toBeGreaterThanOrEqual(0);
    expect(getCar(world, 0, Car.Deliveries)).toBe(1);
    expect(getCar(world, 0, Car.Cash)).toBeGreaterThan(0);

    // The bank froze for the whole ride, lost exactly the one drop-off tick —
    // the cab ends that tick empty, per the S-11 rule — and gained the bonus.
    expect(getCar(world, 0, Car.DeadheadTicks)).toBe(
      bankAtPickup - 1 + ClockTuning.deliveryBonusTicks,
    );
  });

  it('is reproducible tick for tick', () => {
    const play = (): World => {
      let world = createWorld(0x10a, 1, simpleCity());
      for (let tick = 0; tick < 1_500; tick += 1) {
        world = step(world, [0]);
        if (tick % 300 === 0) world = moveCab(world, 100, 0);
        if (tick % 300 === 150) world = moveCab(world, 0, 0);
      }
      return world;
    };
    expect(hashWorld(play())).toBe(hashWorld(play()));
  });
});

describe('withinRadius', () => {
  it('agrees with a real distance', () => {
    const r = fxFromInt(5);
    expect(withinRadius(0, 0, fxFromInt(3), fxFromInt(4), r)).toBe(true);
    expect(withinRadius(0, 0, fxFromInt(4), fxFromInt(4), r)).toBe(false);
    expect(withinRadius(0, 0, 0, 0, r)).toBe(true);
  });

  it('does not overflow on far-apart absolute positions', () => {
    // ADR 0003: squaring an absolute coordinate overflows 16.16 by an order of
    // magnitude, so the per-axis rejection has to come FIRST. Two cabs at
    // opposite corners of the world is the case that would break a naive
    // implementation — it would wrap and report a hit.
    const corner = fxFromInt(WORLD_MAX);
    expect(withinRadius(-corner, -corner, corner, corner, FareTuning.pickupRadius)).toBe(false);
    expect(withinRadius(0, 0, corner, 0, FareTuning.pickupRadius)).toBe(false);
    expect(withinRadius(corner, corner, corner, corner, FareTuning.pickupRadius)).toBe(true);
  });

  it('is symmetric', () => {
    const r = fxFromInt(3);
    for (const [ax, ay, bx, by] of [
      [0, 0, 2, 2],
      [10, -10, 11, -12],
      [-5, 5, 5, -5],
    ] as const) {
      expect(withinRadius(fxFromInt(ax), fxFromInt(ay), fxFromInt(bx), fxFromInt(by), r)).toBe(
        withinRadius(fxFromInt(bx), fxFromInt(by), fxFromInt(ax), fxFromInt(ay), r),
      );
    }
  });
});

describe('no city', () => {
  it('does nothing at all', () => {
    let world = createWorld(1, 1);
    world = run(world, 500);
    expect(getCar(world, 0, Car.Cash)).toBe(0);
    expect(getCar(world, 0, Car.CarriedPassenger)).toBe(NO_PASSENGER);
    for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
      expect(isPassengerActive(world, slot)).toBe(false);
    }
  });
});
