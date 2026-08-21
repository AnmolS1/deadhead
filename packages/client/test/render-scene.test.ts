import { describe, expect, it } from 'vitest';

import {
  Car,
  NO_CARRIER,
  NO_PASSENGER,
  Passenger,
  PassengerFlags,
  Traffic,
  TrafficFlags,
  createWorld,
  fxFromInt,
  setCar,
  setPassenger,
  setTraffic,
} from '@deadhead/sim';

import { GroundCache } from '../src/render/chunks.js';
import { LAYERS, renderScene, type FrameContext } from '../src/render/scene.js';
import { type ViewportState } from '../src/render/viewport.js';

/**
 * A context that records every call.
 *
 * A complete stand-in, unlike a fake chunk surface: a context is only ever
 * called, never handed to a browser API, so recording the calls captures
 * everything the renderer actually does.
 */
function recorder() {
  const calls: string[] = [];
  /** Every fill, with the style in force at the moment it happened. */
  const fills: { style: string; kind: 'rect' | 'path' }[] = [];
  const context: FrameContext = {
    save: () => void calls.push('save'),
    restore: () => void calls.push('restore'),
    translate: (x, y) => void calls.push(`translate(${x},${y})`),
    rotate: (a) => void calls.push(`rotate(${a.toFixed(4)})`),
    scale: (x, y) => void calls.push(`scale(${x},${y})`),
    clearRect: () => void calls.push('clearRect'),
    fillRect: (x, y) => {
      // Style captured HERE, not read back at the end. Every layer sets
      // fillStyle before its loop — including layers with nothing to draw — so
      // the last value on the context belongs to the last layer that ran, not
      // to the last thing actually painted.
      fills.push({ style: String(context.fillStyle), kind: 'rect' });
      calls.push(`fillRect(${x.toFixed(1)},${y.toFixed(1)})`);
    },
    beginPath: () => void calls.push('beginPath'),
    closePath: () => void calls.push('closePath'),
    moveTo: (x, y) => void calls.push(`moveTo(${x.toFixed(1)},${y.toFixed(1)})`),
    lineTo: (x, y) => void calls.push(`lineTo(${x.toFixed(1)},${y.toFixed(1)})`),
    fill: () => {
      fills.push({ style: String(context.fillStyle), kind: 'path' });
      calls.push('fill');
    },
    stroke: () => void calls.push('stroke'),
    setLineDash: () => void calls.push('setLineDash'),
    drawImage: (_image, dx, dy) => void calls.push(`drawImage(${dx},${dy})`),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    globalAlpha: 1,
  };
  return { context, calls, fills };
}

/** A chunk double that can actually be painted into and blitted. */
interface FakeSurface {
  readonly width: number;
  readonly height: number;
  readonly painted: string[];
}

function groundCache() {
  return new GroundCache<FakeSurface>({
    chunkUnits: 64,
    pixelsPerUnit: 1,
    budgetBytes: 64 * 64 * 4 * 64,
    createSurface: (width, height) => ({ width, height, painted: [] }),
    paint: (surface, bounds) => void surface.painted.push(`${bounds.minX},${bounds.minY}`),
  });
}

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

// ---------------------------------------------------------------------------

describe('renderScene', () => {
  it('sets the camera up before drawing and unwinds it after', () => {
    const world = createWorld(1, 1);
    const { context, calls } = recorder();

    // Deliberately off the origin. A camera at (0,0) makes the final translate
    // read `translate(0,0)` whether or not it is negated, so the origin cannot
    // tell a correct transform from one missing its minus sign.
    const state = view({ x: 10, y: 20, rotation: 0.5 });
    renderScene(context, { previous: world, current: world, view: state, alpha: 0 });

    expect(calls[0]).toBe('save');
    expect(calls).toContain('clearRect');
    expect(calls.at(-1)).toBe('restore');
    // The camera order from viewport.ts, written down once so a layer cannot
    // quietly reorder it: centre, un-rotate, scale, then offset by the camera.
    expect(calls.slice(0, 6)).toEqual([
      'save',
      'clearRect',
      'translate(500,300)',
      'rotate(-0.5000)',
      'scale(10,10)',
      'translate(-10,-20)',
    ]);
  });

  it('draws shadows before the cars that cast them', () => {
    // The layer order IS the drawing. A shadow after its body paints over it.
    const world = createWorld(1, 1);
    setCar(world, 0, Car.X, fxFromInt(10));
    setCar(world, 0, Car.CarriedPassenger, NO_PASSENGER);
    const { context, fills } = recorder();

    renderScene(context, { previous: world, current: world, view: view(), alpha: 0 });

    // The shadow is the graphite one, and it comes first.
    const shadow = fills.findIndex((f) => f.style.includes('27, 42, 51'));
    const body = fills.findIndex((f) => f.style === '#E84A27');
    expect(shadow, JSON.stringify(fills)).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThanOrEqual(0);
    expect(shadow).toBeLessThan(body);
  });

  it('blits every visible ground chunk, and reaches the context to do it', () => {
    // The gap this test exists for. The cache's eviction policy was tested to
    // death while nothing ever checked that a chunk reaches a canvas — and the
    // surface type had been narrowed to {width, height}, which drawImage
    // cannot accept. Green tests, unusable renderer.
    const world = createWorld(1, 1);
    const { context, calls } = recorder();
    const cache = groundCache();
    const blitted: string[] = [];

    const stats = renderScene(context, {
      previous: world,
      current: world,
      view: view(),
      alpha: 0,
      ground: {
        cache,
        blit: (ctx, surface, bounds) => {
          blitted.push(`${bounds.minX},${bounds.minY}`);
          ctx.drawImage(surface, bounds.minX, bounds.minY, 64, 64);
        },
      },
    });

    // The view spans ±50 × ±30, which touches four 64-unit chunks around the origin.
    expect(stats.ground.drawn).toBe(4);
    expect(blitted).toHaveLength(4);
    expect(calls.filter((c) => c.startsWith('drawImage'))).toHaveLength(4);
  });

  it('paints each chunk once across many frames', () => {
    // Proves the cache is actually in the path rather than beside it.
    const world = createWorld(1, 1);
    const { context } = recorder();
    const cache = groundCache();
    const surfaces = new Set<FakeSurface>();

    for (let frame = 0; frame < 10; frame += 1) {
      renderScene(context, {
        previous: world,
        current: world,
        view: view(),
        alpha: 0,
        ground: {
          cache,
          blit: (_ctx, surface) => void surfaces.add(surface),
        },
      });
    }

    expect(surfaces.size).toBe(4);
    for (const surface of surfaces) expect(surface.painted).toHaveLength(1);
    expect(cache.stats().misses).toBe(4);
  });

  it('skips the ground entirely when no cache is supplied', () => {
    // W-02's editor draws its own ground while reusing everything else.
    const world = createWorld(1, 1);
    const { context, calls } = recorder();

    const stats = renderScene(context, {
      previous: world,
      current: world,
      view: view(),
      alpha: 0,
    });

    expect(stats.ground.drawn).toBe(0);
    expect(calls.filter((c) => c.startsWith('drawImage'))).toHaveLength(0);
  });

  it('distinguishes a carrying cab from an empty one', () => {
    // The contrast is the entire game (DESIGN.md §2.1). C-08 makes it felt;
    // this only checks the renderer can tell them apart at all.
    const styleOfCab = (carried: number): string => {
      const world = createWorld(1, 1);
      setCar(world, 0, Car.CarriedPassenger, carried);
      const { context, fills } = recorder();
      renderScene(context, { previous: world, current: world, view: view(), alpha: 0 });
      // The first fill after the shadow is the cab's lit half.
      const shadowStyle = fills[0]?.style ?? '';
      return fills.find((f) => f.style !== shadowStyle)?.style ?? '';
    };

    // An empty cab is the accent; a carrying one is ink. ADR 0001 reserves the
    // accent for motion and the empty-cab state — the screen is loud while you
    // are losing and quiet while you are earning.
    expect(styleOfCab(NO_PASSENGER)).toBe('#E84A27');
    expect(styleOfCab(4)).not.toBe('#E84A27');
  });

  it('reports counts for every layer it drew', () => {
    const world = createWorld(1, 2);
    setCar(world, 0, Car.X, fxFromInt(5));
    setCar(world, 1, Car.X, fxFromInt(900));
    setTraffic(world, 0, Traffic.Flags, TrafficFlags.Active);
    setPassenger(world, 0, Passenger.Flags, PassengerFlags.Active);
    // Carrier must be set explicitly. createWorld zeroes the table and 0 is a
    // valid car index, so an untouched Carrier reads as "carried by cab 0" and
    // the passenger is correctly hidden. The sim never hits this — spawn sets
    // NO_CARRIER (passengers.ts) — but hand-built worlds in tests can.
    setPassenger(world, 0, Passenger.Carrier, NO_CARRIER);
    const { context } = recorder();

    const stats = renderScene(context, {
      previous: world,
      current: world,
      view: view(),
      alpha: 0,
    });

    expect(stats.cars).toEqual({ considered: 2, drawn: 1 });
    expect(stats.traffic.considered).toBe(1);
    expect(stats.pickups.considered).toBe(1);
    // Every layer is present, even the ones C-04 leaves empty.
    for (const layer of LAYERS) expect(stats[layer]).toBeDefined();
  });
});
