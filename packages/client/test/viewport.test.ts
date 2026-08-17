import { describe, expect, it } from 'vitest';

import {
  containsPoint,
  overlaps,
  screenToWorld,
  visibleBounds,
  worldToScreen,
  type ViewportState,
} from '../src/render/viewport.js';

/** A 1000×600 view, centred at the origin, 10 device pixels per world unit. */
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

describe('visibleBounds', () => {
  it('covers exactly the screen when the camera is not rotated', () => {
    // 1000 px / (10 px per unit) = 100 units wide, so ±50.
    const bounds = visibleBounds(view());
    expect(bounds.minX).toBeCloseTo(-50, 9);
    expect(bounds.maxX).toBeCloseTo(50, 9);
    expect(bounds.minY).toBeCloseTo(-30, 9);
    expect(bounds.maxY).toBeCloseTo(30, 9);
  });

  it('follows the camera', () => {
    const bounds = visibleBounds(view({ x: 200, y: -100 }));
    expect(bounds.minX).toBeCloseTo(150, 9);
    expect(bounds.maxX).toBeCloseTo(250, 9);
    expect(bounds.minY).toBeCloseTo(-130, 9);
    expect(bounds.maxY).toBeCloseTo(-70, 9);
  });

  it('widens as the camera zooms out', () => {
    // C-03 zooms out with speed, so the cull has to follow or the edges of a
    // fast screen go empty.
    const wide = visibleBounds(view({ zoom: 0.5 }));
    expect(wide.maxX).toBeCloseTo(100, 9);
    expect(wide.maxY).toBeCloseTo(60, 9);
  });

  it('grows when the camera is rotated', () => {
    // The bug this exists for. A rotated rectangle covers a LARGER axis-aligned
    // area — up to √2 at 45° — and culling against the unrotated box drops the
    // corners of a turned screen. Only when turning, which is exactly the kind
    // of bug a straight-line playtest never finds.
    const straight = visibleBounds(view());
    const turned = visibleBounds(view({ rotation: Math.PI / 4 }));

    expect(turned.maxX).toBeGreaterThan(straight.maxX);
    expect(turned.maxY).toBeGreaterThan(straight.maxY);
    // At 45° both extents become (50 + 30) / √2 × ... = (50+30)·cos45 ≈ 56.57.
    expect(turned.maxX).toBeCloseTo((50 + 30) * Math.SQRT1_2, 6);
    expect(turned.maxY).toBeCloseTo((50 + 30) * Math.SQRT1_2, 6);
  });

  it('is never smaller than the unrotated view, at any angle', () => {
    // The cull must be conservative in one direction only: it may keep
    // something just off screen; it must never drop something on it.
    const straight = visibleBounds(view());
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 32) {
      const turned = visibleBounds(view({ rotation: angle }));
      const corner = Math.max(
        Math.abs(straight.maxX * Math.cos(angle)) + Math.abs(straight.maxY * Math.sin(angle)),
        0,
      );
      expect(turned.maxX + 1e-9, `angle ${angle}`).toBeGreaterThanOrEqual(corner);
    }
  });

  it('keeps every visible screen corner inside the bounds', () => {
    // The property stated directly: take the four corners of the screen, put
    // them back into world space, and they must all fall inside the cull box.
    for (const rotation of [0, 0.3, Math.PI / 4, 1.9, Math.PI, 5.2]) {
      const state = view({ rotation, x: 40, y: -25, zoom: 0.8 });
      const bounds = visibleBounds(state);

      for (const [sx, sy] of [
        [0, 0],
        [state.width, 0],
        [0, state.height],
        [state.width, state.height],
      ] as const) {
        const world = screenToWorld(state, sx, sy);
        expect(world.x, `rot ${rotation}`).toBeGreaterThanOrEqual(bounds.minX - 1e-6);
        expect(world.x, `rot ${rotation}`).toBeLessThanOrEqual(bounds.maxX + 1e-6);
        expect(world.y, `rot ${rotation}`).toBeGreaterThanOrEqual(bounds.minY - 1e-6);
        expect(world.y, `rot ${rotation}`).toBeLessThanOrEqual(bounds.maxY + 1e-6);
      }
    }
  });

  it('adds the margin a caller asks for', () => {
    // So a cab straddling the edge is drawn rather than popping in when its
    // centre crosses.
    expect(visibleBounds(view(), 5).maxX).toBeCloseTo(55, 9);
  });
});

describe('overlaps', () => {
  const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

  it('accepts anything touching', () => {
    expect(overlaps(box, { minX: 5, minY: 5, maxX: 15, maxY: 15 })).toBe(true);
    expect(overlaps(box, { minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBe(true);
    expect(overlaps(box, { minX: -5, minY: -5, maxX: 20, maxY: 20 })).toBe(true);
  });

  it('rejects anything separated on either axis', () => {
    expect(overlaps(box, { minX: 11, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
    expect(overlaps(box, { minX: 0, minY: 11, maxX: 10, maxY: 20 })).toBe(false);
  });

  it('is symmetric', () => {
    const other = { minX: 5, minY: -20, maxX: 6, maxY: 2 };
    expect(overlaps(box, other)).toBe(overlaps(other, box));
  });
});

describe('containsPoint', () => {
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

  it('accounts for radius at the edge', () => {
    expect(containsPoint(bounds, -1, 5)).toBe(false);
    expect(containsPoint(bounds, -1, 5, 2)).toBe(true);
  });

  it('accepts the interior and rejects the far outside', () => {
    expect(containsPoint(bounds, 5, 5)).toBe(true);
    expect(containsPoint(bounds, 500, 5, 3)).toBe(false);
  });
});

describe('worldToScreen and screenToWorld', () => {
  it('puts the camera centre at the centre of the canvas', () => {
    const state = view({ x: 123, y: -45 });
    const screen = worldToScreen(state, 123, -45);
    expect(screen.x).toBeCloseTo(500, 9);
    expect(screen.y).toBeCloseTo(300, 9);
  });

  it('scales by zoom and pixel density', () => {
    const screen = worldToScreen(view(), 10, 0);
    expect(screen.x).toBeCloseTo(500 + 100, 9);

    const zoomed = worldToScreen(view({ zoom: 0.5 }), 10, 0);
    expect(zoomed.x).toBeCloseTo(500 + 50, 9);
  });

  it('round-trips through world space at any rotation', () => {
    // The two must be exact inverses or picking (W-02's editor) lands somewhere
    // other than where the cursor is, and only when the camera is turned.
    for (const rotation of [0, 0.7, Math.PI / 2, 3.4, 6.1]) {
      const state = view({ rotation, x: -30, y: 90, zoom: 1.3 });
      for (const [x, y] of [
        [0, 0],
        [-30, 90],
        [12, -400],
        [999, 999],
      ] as const) {
        const back = screenToWorld(state, worldToScreen(state, x, y).x, worldToScreen(state, x, y).y);
        expect(back.x, `rot ${rotation}`).toBeCloseTo(x, 6);
        expect(back.y, `rot ${rotation}`).toBeCloseTo(y, 6);
      }
    }
  });

  it('turns the world by exactly minus the camera rotation', () => {
    // The contract, pinned to a specific pixel. `rotation` is how far the world
    // is turned, NOT "the direction that ends up at the top" — that looser
    // phrasing is wrong by a quarter turn and reads as if it were right. A
    // world direction θ lands at screen angle θ − rotation, with y downward.
    const state = view({ rotation: Math.PI / 2 });
    const screen = worldToScreen(state, 10, 0);

    // World +X, minus a quarter turn, is straight up the screen — and screen y
    // grows downward, so up is 300 − 100.
    expect(screen.x).toBeCloseTo(500, 6);
    expect(screen.y).toBeCloseTo(300 - 100, 6);
  });

  it('agrees with what C-03 sets, so the cab points up the screen', () => {
    // The cross-module check. C-03 sets `rotation = heading + π/2` precisely so
    // that the cab ends up pointing up; this asserts the renderer honours it,
    // rather than each module being self-consistent and wrong together.
    for (const heading of [0, 0.9, Math.PI / 2, 2.5, Math.PI, 4.7]) {
      const state = view({ rotation: heading + Math.PI / 2 });
      const nose = worldToScreen(state, Math.cos(heading) * 10, Math.sin(heading) * 10);

      expect(nose.x, `heading ${heading}`).toBeCloseTo(500, 6);
      expect(nose.y, `heading ${heading}`).toBeLessThan(300);
    }
  });
});
