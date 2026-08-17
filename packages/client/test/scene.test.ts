import { describe, expect, it } from 'vitest';

import {
  Car,
  CarFlags,
  NO_CARRIER,
  Passenger,
  PassengerFlags,
  Traffic,
  TrafficFlags,
  createWorld,
  cloneWorld,
  fxFromInt,
  setCar,
  setPassenger,
  setTraffic,
  type World,
} from '@deadhead/sim';

import {
  LAYERS,
  cullRatio,
  emptyFrameStats,
  totalConsidered,
  totalDrawn,
  visibleCars,
  visiblePassengers,
  visibleTraffic,
} from '../src/render/scene.js';
import { type ViewportState } from '../src/render/viewport.js';

/** A 1000×600 view at the origin: ±50 × ±30 world units. */
function view(overrides: Partial<ViewportState> = {}): ViewportState {
  return {
    x: 0,
    y: 0,
    rotation: 0,
    zoom: 1,
    width: 1000,
    height: 600,
    pixelsPerUnit: 10,
    ...overrides,
  };
}

function placeCar(world: World, slot: number, x: number, y: number): void {
  setCar(world, slot, Car.X, fxFromInt(x));
  setCar(world, slot, Car.Y, fxFromInt(y));
}

// ---------------------------------------------------------------------------

describe('layer order', () => {
  it('is fixed, and draws back to front', () => {
    // The order IS the drawing. Shadows must precede the bodies that cast them;
    // the overlay must be last or the HUD ends up under the traffic.
    expect(LAYERS.indexOf('ground')).toBe(0);
    expect(LAYERS.indexOf('overlay')).toBe(LAYERS.length - 1);
    expect(LAYERS.indexOf('shadows')).toBeLessThan(LAYERS.indexOf('cars'));
    expect(LAYERS.indexOf('ground')).toBeLessThan(LAYERS.indexOf('markings'));
    expect(LAYERS.indexOf('particles')).toBeGreaterThan(LAYERS.indexOf('cars'));
  });

  it('starts every layer at zero', () => {
    const stats = emptyFrameStats();
    for (const layer of LAYERS) {
      expect(stats[layer]).toEqual({ considered: 0, drawn: 0 });
    }
    expect(totalDrawn(stats)).toBe(0);
  });
});

describe('cars', () => {
  it('draws a cab that is on screen', () => {
    const world = createWorld(1, 2);
    placeCar(world, 0, 10, 5);
    const stats = emptyFrameStats();

    const drawn = visibleCars(world, world, view(), 0, stats.cars);
    expect(drawn.map((d) => d.slot)).toContain(0);
    expect(drawn[0]?.pose.x).toBeCloseTo(10, 6);
  });

  it('culls a cab that is off screen', () => {
    // The whole point. On W-03's 1,200-unit city with twelve cabs, most are
    // nowhere near the view and drawing them is pure waste.
    const world = createWorld(1, 2);
    placeCar(world, 0, 10, 5);
    placeCar(world, 1, 400, 400);
    const stats = emptyFrameStats();

    const drawn = visibleCars(world, world, view(), 0, stats.cars);
    expect(drawn.map((d) => d.slot)).toEqual([0]);
    expect(stats.cars.considered).toBe(2);
    expect(stats.cars.drawn).toBe(1);
  });

  it('keeps a cab straddling the edge rather than popping it', () => {
    // Just past the right edge at x=50, but within the 3-unit margin. Culling
    // on the centre alone would make cabs vanish half-drawn at the boundary.
    const world = createWorld(1, 1);
    placeCar(world, 0, 52, 0);
    const stats = emptyFrameStats();

    expect(visibleCars(world, world, view(), 0, stats.cars)).toHaveLength(1);
  });

  it('never considers an eliminated cab', () => {
    // Elimination is final (CarFlags.Eliminated). An eliminated cab is off the
    // board, so it should not even count as a candidate — otherwise the cull
    // ratio slowly lies as a match wears on.
    const world = createWorld(1, 3);
    placeCar(world, 0, 0, 0);
    placeCar(world, 1, 0, 0);
    placeCar(world, 2, 0, 0);
    setCar(world, 1, Car.Flags, CarFlags.Eliminated);
    const stats = emptyFrameStats();

    const drawn = visibleCars(world, world, view(), 0, stats.cars);
    expect(drawn.map((d) => d.slot)).toEqual([0, 2]);
    expect(stats.cars.considered).toBe(2);
  });

  it('ignores slots past the player count', () => {
    // A 2-player world has ten empty car slots. Reading them would draw ten
    // cabs stacked at the origin.
    const world = createWorld(1, 2);
    const stats = emptyFrameStats();
    visibleCars(world, world, view(), 0, stats.cars);
    expect(stats.cars.considered).toBe(2);
  });

  it('interpolates between the two states', () => {
    const previous = createWorld(1, 1);
    placeCar(previous, 0, 0, 0);
    const current = cloneWorld(previous);
    placeCar(current, 0, 2, 0);
    const stats = emptyFrameStats();

    const half = visibleCars(previous, current, view(), 0.5, stats.cars);
    expect(half[0]?.pose.x).toBeCloseTo(1, 6);
  });

  it('snaps a teleport instead of sliding the cab across the city', () => {
    // A respawn (G-01) or a hard correction (M-06). Interpolating it drags the
    // cab visibly across everything in between, which is far worse than a cut.
    const previous = createWorld(1, 1);
    placeCar(previous, 0, 0, 0);
    const current = cloneWorld(previous);
    placeCar(current, 0, 40, 0);
    const stats = emptyFrameStats();

    const drawn = visibleCars(previous, current, view(), 0.5, stats.cars);
    // Interpolated it would sit at 20. Snapped, it is already at 40.
    expect(drawn[0]?.pose.x).toBeCloseTo(40, 6);
  });
});

describe('traffic', () => {
  it('skips inactive slots and culls the rest', () => {
    const world = createWorld(1, 1);
    setTraffic(world, 0, Traffic.Flags, TrafficFlags.Active);
    setTraffic(world, 0, Traffic.X, fxFromInt(5));
    setTraffic(world, 1, Traffic.Flags, TrafficFlags.Active);
    setTraffic(world, 1, Traffic.X, fxFromInt(900));
    // Slot 2 left inactive.
    const stats = emptyFrameStats();

    const drawn = visibleTraffic(world, world, view(), 0, stats.traffic);
    expect(drawn.map((d) => d.slot)).toEqual([0]);
    expect(stats.traffic.considered).toBe(2);
    expect(stats.traffic.drawn).toBe(1);
  });
});

describe('passengers', () => {
  it('draws a waiting passenger', () => {
    const world = createWorld(1, 1);
    setPassenger(world, 0, Passenger.Flags, PassengerFlags.Active);
    setPassenger(world, 0, Passenger.Carrier, NO_CARRIER);
    setPassenger(world, 0, Passenger.X, fxFromInt(8));
    const stats = emptyFrameStats();

    expect(visiblePassengers(world, view(), stats.pickups)).toHaveLength(1);
  });

  it('excludes a carried passenger, who would otherwise ride on the roof', () => {
    // "Carried" is the Carrier field, not a flag — the easy mistake here is to
    // look for a bit that does not exist, draw everyone, and put a pickup
    // marker on top of the cab carrying them.
    const world = createWorld(1, 1);
    setPassenger(world, 0, Passenger.Flags, PassengerFlags.Active);
    setPassenger(world, 0, Passenger.Carrier, 3);
    setPassenger(world, 0, Passenger.X, fxFromInt(8));
    const stats = emptyFrameStats();

    expect(visiblePassengers(world, view(), stats.pickups)).toHaveLength(0);
    expect(stats.pickups.considered).toBe(0);
  });

  it('skips inactive slots', () => {
    const world = createWorld(1, 1);
    const stats = emptyFrameStats();
    expect(visiblePassengers(world, view(), stats.pickups)).toHaveLength(0);
    expect(stats.pickups.considered).toBe(0);
  });
});

describe('the cull ratio is the proof culling works', () => {
  it('falls well below 1 on a spread-out city', () => {
    // The number C-06 shows. At 1 the cull is doing nothing, and that is the
    // failure this whole file exists to make visible rather than mysterious.
    const world = createWorld(1, 12);
    for (let slot = 0; slot < 12; slot += 1) {
      placeCar(world, slot, slot * 100, slot * 90);
    }
    for (let slot = 0; slot < 40; slot += 1) {
      setTraffic(world, slot, Traffic.Flags, TrafficFlags.Active);
      setTraffic(world, slot, Traffic.X, fxFromInt((slot % 10) * 120));
      setTraffic(world, slot, Traffic.Y, fxFromInt(Math.floor(slot / 10) * 300));
    }

    const stats = emptyFrameStats();
    visibleCars(world, world, view(), 0, stats.cars);
    visibleTraffic(world, world, view(), 0, stats.traffic);

    expect(totalConsidered(stats)).toBe(52);
    expect(cullRatio(stats)).toBeLessThan(0.2);
  });

  it('is 1 when everything really is on screen, and does not pretend otherwise', () => {
    // The honest other half. A cull ratio of 1 is correct when the cabs are
    // genuinely all in view — the metric reports reality, it does not flatter.
    const world = createWorld(1, 4);
    for (let slot = 0; slot < 4; slot += 1) placeCar(world, slot, slot * 5, 0);

    const stats = emptyFrameStats();
    visibleCars(world, world, view(), 0, stats.cars);
    expect(cullRatio(stats)).toBe(1);
  });

  it('reports zero rather than dividing by zero on an empty frame', () => {
    expect(cullRatio(emptyFrameStats())).toBe(0);
  });
});
