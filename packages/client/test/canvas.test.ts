import { describe, expect, it, afterEach } from 'vitest';

import { resizeCanvas } from '../src/canvas.js';

/**
 * A canvas has two sizes — the CSS box and the backing store — and confusing
 * them is the most common reason a browser game looks soft. These tests use a
 * hand-rolled stub rather than jsdom: the logic under test is arithmetic and a
 * short-circuit, and pulling in a DOM implementation to check multiplication
 * would be a dependency bought for nothing.
 */

interface FakeCanvas {
  width: number;
  height: number;
  getBoundingClientRect(): { width: number; height: number };
}

function fakeCanvas(cssWidth: number, cssHeight: number): FakeCanvas {
  return {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: cssWidth, height: cssHeight }),
  };
}

function withPixelRatio(ratio: number): void {
  (globalThis as { window?: { devicePixelRatio: number } }).window = { devicePixelRatio: ratio };
}

const resize = (canvas: FakeCanvas) => resizeCanvas(canvas as unknown as HTMLCanvasElement);

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('resizeCanvas', () => {
  it('allocates one backing pixel per device pixel', () => {
    withPixelRatio(2);
    const canvas = fakeCanvas(800, 600);

    expect(resize(canvas)).toEqual({ width: 1600, height: 1200, pixelRatio: 2 });
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
  });

  it('matches the CSS box on a 1x display', () => {
    withPixelRatio(1);
    expect(resize(fakeCanvas(1280, 720))).toEqual({ width: 1280, height: 720, pixelRatio: 1 });
  });

  it('caps the ratio at 2x', () => {
    // A 3x phone or 4x monitor would otherwise allocate nine or sixteen times
    // the pixels for flat-shaded art that has no detail at that scale (D-02),
    // and P-02 has a frame budget to protect.
    withPixelRatio(4);
    expect(resize(fakeCanvas(800, 600))).toEqual({ width: 1600, height: 1200, pixelRatio: 2 });
  });

  it('survives a fractional device pixel ratio', () => {
    withPixelRatio(1.5);
    expect(resize(fakeCanvas(801, 601))).toEqual({
      width: Math.round(801 * 1.5),
      height: Math.round(601 * 1.5),
      pixelRatio: 1.5,
    });
  });

  it('reports no change when nothing changed', () => {
    // Called every frame, so it must be cheap to ignore — C-04 will reallocate
    // offscreen render targets on a real resize and must not do it 144 times a
    // second.
    withPixelRatio(2);
    const canvas = fakeCanvas(800, 600);
    expect(resize(canvas)).not.toBeNull();
    expect(resize(canvas)).toBeNull();
    expect(resize(canvas)).toBeNull();
  });

  it('reports the change when the box moves', () => {
    withPixelRatio(1);
    const canvas = fakeCanvas(800, 600);
    resize(canvas);

    canvas.getBoundingClientRect = () => ({ width: 1024, height: 768 });
    expect(resize(canvas)).toEqual({ width: 1024, height: 768, pixelRatio: 1 });
  });

  it('never allocates a zero-sized backing store', () => {
    // A canvas in a collapsed layout box reports 0x0, and a zero-width canvas
    // throws on some operations rather than merely drawing nothing.
    withPixelRatio(2);
    const viewport = resize(fakeCanvas(0, 0));
    expect(viewport?.width).toBe(1);
    expect(viewport?.height).toBe(1);
  });

  it('falls back to 1x when the platform does not report a ratio', () => {
    (globalThis as { window?: { devicePixelRatio: number } }).window = {
      devicePixelRatio: 0 as number,
    };
    expect(resize(fakeCanvas(400, 300))?.pixelRatio).toBe(1);
  });
});
