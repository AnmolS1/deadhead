import { describe, expect, it } from 'vitest';

import { ClockTuning, beginFare, endFare, grantDeadhead, isDriving } from '../src/clock.js';
import { TICK_HZ } from '../src/constants.js';
import { step } from '../src/step.js';
import {
  Car,
  CarFlags,
  Header,
  NO_PASSENGER,
  WorldFlags,
  createWorld,
  getCar,
  isRunning,
  type World,
} from '../src/world.js';

const deadhead = (world: World, slot = 0): number => getCar(world, slot, Car.DeadheadTicks);
const fare = (world: World, slot = 0): number => getCar(world, slot, Car.FareTicks);

/**
 * Run a scripted sequence of empty/carrying stretches and report exact counts.
 *
 * Pickups and drop-offs are applied *before* the step that they take effect on,
 * which is where `S-09` will resolve them — between movement and the clocks.
 */
function script(stretches: readonly { carrying: boolean; ticks: number }[]): {
  world: World;
  burned: number;
  accrued: number;
  total: number;
} {
  let world = createWorld(1, 1);
  const startingBank = deadhead(world);
  let accrued = 0;
  let total = 0;
  let carrying = false;

  for (const stretch of stretches) {
    if (stretch.carrying !== carrying) {
      // Ends as a bail, not a delivery. A delivery grants deliveryBonusTicks
      // back, which is a *grant* rather than a tick of the clock — it would
      // inflate the bank and make this measure something other than the
      // invariant it is checking.
      if (stretch.carrying) beginFare(world, 0, 7);
      else endFare(world, 0, false);
      carrying = stretch.carrying;
    }
    for (let i = 0; i < stretch.ticks; i += 1) {
      world = step(world, [0]);
      total += 1;
      if (carrying) accrued += 1;
    }
  }

  return { world, burned: startingBank - deadhead(world), accrued, total };
}

// ---------------------------------------------------------------------------

describe('the tick rule', () => {
  it('burns deadhead on every tick the cab ends empty', () => {
    let world = createWorld(1, 1);
    const start = deadhead(world);
    for (let i = 0; i < 100; i += 1) world = step(world, [0]);
    expect(deadhead(world)).toBe(start - 100);
  });

  it('freezes deadhead on every tick the cab ends carrying', () => {
    let world = createWorld(1, 1);
    for (let i = 0; i < 50; i += 1) world = step(world, [0]);
    const frozenAt = deadhead(world);

    beginFare(world, 0, 3);
    for (let i = 0; i < 500; i += 1) world = step(world, [0]);

    expect(deadhead(world)).toBe(frozenAt);
    expect(fare(world)).toBe(500);
  });

  it('does NOT burn deadhead on the pickup tick', () => {
    // The decision S-11 asks to be made explicitly. The rule is written in
    // terms of end-of-tick state: the cab is carrying when this tick ends, so
    // the deadhead clock does not move and the fare clock counts it.
    let world = createWorld(1, 1);
    for (let i = 0; i < 10; i += 1) world = step(world, [0]);
    const before = deadhead(world);

    beginFare(world, 0, 1);
    world = step(world, [0]);

    expect(deadhead(world)).toBe(before);
    expect(fare(world)).toBe(1);
  });

  it('DOES burn deadhead on the drop-off tick', () => {
    // The mirror of the rule, and the reason there is no grace period in
    // either direction: the cab ends this tick empty.
    let world = createWorld(1, 1);
    beginFare(world, 0, 1);
    for (let i = 0; i < 20; i += 1) world = step(world, [0]);
    const before = deadhead(world);

    endFare(world, 0, false);
    world = step(world, [0]);

    expect(deadhead(world)).toBe(before - 1);
    expect(fare(world)).toBe(0);
  });

  it('advances exactly one of the two clocks per tick', () => {
    // The invariant the whole file exists to hold: burned + accrued === ticks.
    // Not "roughly frozen" — to the tick, over a scripted sequence.
    const { burned, accrued, total } = script([
      { carrying: false, ticks: 37 },
      { carrying: true, ticks: 211 },
      { carrying: false, ticks: 5 },
      { carrying: true, ticks: 64 },
      { carrying: false, ticks: 128 },
    ]);

    expect(total).toBe(37 + 211 + 5 + 64 + 128);
    expect(accrued).toBe(211 + 64);
    expect(burned).toBe(37 + 5 + 128);
    expect(burned + accrued).toBe(total);
  });

  it('holds the invariant across many alternating stretches', () => {
    let world = createWorld(1, 1);
    const start = deadhead(world);
    let carrying = false;
    let carriedTicks = 0;

    for (let block = 0; block < 60; block += 1) {
      const ticks = 1 + (block % 9);
      const wantCarrying = block % 2 === 1;
      if (wantCarrying !== carrying) {
        if (wantCarrying) beginFare(world, 0, block % 8);
        else endFare(world, 0, false);
        carrying = wantCarrying;
      }
      for (let i = 0; i < ticks; i += 1) {
        world = step(world, [0]);
        if (carrying) carriedTicks += 1;
      }
    }

    expect(start - deadhead(world) + carriedTicks).toBe(world.data[Header.Tick]);
  });
});

describe('the fare clock', () => {
  it('starts at zero for each new fare', () => {
    let world = createWorld(1, 1);
    beginFare(world, 0, 1);
    for (let i = 0; i < 40; i += 1) world = step(world, [0]);
    expect(fare(world)).toBe(40);

    endFare(world, 0, true);
    expect(fare(world)).toBe(0);

    beginFare(world, 0, 2);
    for (let i = 0; i < 7; i += 1) world = step(world, [0]);
    expect(fare(world)).toBe(7);
  });

  it('reports the fare length to whoever prices it', () => {
    // S-10 owns what a fare is worth; S-11 owns how long it ran.
    let world = createWorld(1, 1);
    beginFare(world, 0, 1);
    for (let i = 0; i < 93; i += 1) world = step(world, [0]);
    expect(endFare(world, 0, true)).toBe(93);
  });
});

describe('delivery', () => {
  it('counts a completed delivery and returns deadhead time', () => {
    let world = createWorld(1, 1);
    for (let i = 0; i < 100; i += 1) world = step(world, [0]);
    const before = deadhead(world);

    beginFare(world, 0, 1);
    endFare(world, 0, true);

    expect(getCar(world, 0, Car.Deliveries)).toBe(1);
    expect(deadhead(world)).toBe(before + ClockTuning.deliveryBonusTicks);
  });

  it('pays nothing for a bail — no delivery, no time back', () => {
    // DESIGN.md §2.1: a Meter passenger who runs out of patience bails and you
    // get nothing. The clock half of that is here.
    let world = createWorld(1, 1);
    for (let i = 0; i < 100; i += 1) world = step(world, [0]);
    const before = deadhead(world);

    beginFare(world, 0, 1);
    endFare(world, 0, false);

    expect(getCar(world, 0, Car.Deliveries)).toBe(0);
    expect(deadhead(world)).toBe(before);
  });

  it('clears the carried passenger either way', () => {
    const world = createWorld(1, 1);
    beginFare(world, 0, 5);
    expect(getCar(world, 0, Car.CarriedPassenger)).toBe(5);
    endFare(world, 0, true);
    expect(getCar(world, 0, Car.CarriedPassenger)).toBe(NO_PASSENGER);
  });
});

describe('elimination', () => {
  it('eliminates a cab on the exact tick its bank reaches zero', () => {
    let world = createWorld(1, 1);
    const bank = deadhead(world);

    for (let i = 0; i < bank - 1; i += 1) world = step(world, [0]);
    expect(deadhead(world)).toBe(1);
    expect(isDriving(world, 0)).toBe(true);

    world = step(world, [0]);
    expect(deadhead(world)).toBe(0);
    expect(isDriving(world, 0)).toBe(false);
    expect(getCar(world, 0, Car.Flags) & CarFlags.Eliminated).toBeTruthy();
  });

  it('never lets the bank go negative', () => {
    // Otherwise M-10's "disconnecting is never an advantage" accounting
    // compares the wrong number.
    let world = createWorld(1, 1);
    for (let i = 0; i < ClockTuning.startingDeadheadTicks + 500; i += 1) {
      world = step(world, [0]);
      expect(deadhead(world)).toBeGreaterThanOrEqual(0);
    }
    expect(deadhead(world)).toBe(0);
  });

  it('is final — an eliminated cab cannot be revived', () => {
    // M-09's "last one still driving" is only a win condition if nobody can
    // come back.
    let world = createWorld(1, 1);
    for (let i = 0; i < ClockTuning.startingDeadheadTicks; i += 1) world = step(world, [0]);
    expect(isDriving(world, 0)).toBe(false);

    grantDeadhead(world, 0, 1000);
    expect(deadhead(world)).toBe(0);
    expect(isDriving(world, 0)).toBe(false);
  });

  it('ends the run once no cab is still driving', () => {
    let world = createWorld(1, 1);
    expect(isRunning(world)).toBe(true);
    for (let i = 0; i < ClockTuning.startingDeadheadTicks; i += 1) world = step(world, [0]);
    expect(isRunning(world)).toBe(false);
    expect(world.data[Header.Flags] & WorldFlags.Running).toBe(0);
  });
});

describe('independent clocks', () => {
  it('freezes one cab without freezing the others', () => {
    // The multiplayer core of DESIGN.md §2.3: stealing a fare is the best
    // offence and the best defence at once, because you gain a frozen clock
    // while your opponent keeps burning theirs.
    let world = createWorld(1, 3);
    const start = deadhead(world, 0);

    beginFare(world, 1, 4);
    for (let i = 0; i < 300; i += 1) world = step(world, [0, 0, 0]);

    expect(deadhead(world, 0)).toBe(start - 300);
    expect(deadhead(world, 1)).toBe(start);
    expect(deadhead(world, 2)).toBe(start - 300);
    expect(fare(world, 1)).toBe(300);
  });

  it('keeps the run alive while any cab is still driving', () => {
    let world = createWorld(1, 2);
    beginFare(world, 1, 1);
    for (let i = 0; i < ClockTuning.startingDeadheadTicks + 10; i += 1) {
      world = step(world, [0, 0]);
    }

    expect(isDriving(world, 0)).toBe(false);
    expect(isDriving(world, 1)).toBe(true);
    expect(isRunning(world)).toBe(true);
  });

  it('leaves slots beyond the player count untouched', () => {
    let world = createWorld(1, 2);
    for (let i = 0; i < 100; i += 1) world = step(world, [0, 0]);
    expect(deadhead(world, 5)).toBe(0);
    expect(getCar(world, 5, Car.Flags) & CarFlags.Eliminated).toBe(0);
  });
});

describe('tuning', () => {
  it('starts with the designed bank', () => {
    expect(ClockTuning.startingDeadheadTicks).toBe(180 * TICK_HZ);
    expect(deadhead(createWorld(1, 1))).toBe(ClockTuning.startingDeadheadTicks);
  });

  it('stores clocks as plain tick counters, not fixed point', () => {
    // DeadheadTicks and FareTicks are counts. Passing one through fxMul would
    // reinterpret it as 16.16 and be silent about it.
    let world = createWorld(1, 1);
    for (let i = 0; i < 10; i += 1) world = step(world, [0]);
    expect(deadhead(world)).toBe(ClockTuning.startingDeadheadTicks - 10);
    expect(Number.isInteger(deadhead(world))).toBe(true);
  });
});
