import { describe, expect, it } from 'vitest';

import {
  GroundCache,
  suggestedBudgetBytes,
  type GroundCacheOptions,
} from '../src/render/chunks.js';

/**
 * A chunk double that can be painted into, the way a real surface can.
 *
 * Deliberately more than `{ width, height }`. The first version of this file
 * used exactly that and every test passed — but the cache's surface type was
 * then narrowed to match, and `{ width, height }` has no `getContext` and is
 * not a `CanvasImageSource`, so nothing could paint into it and `drawImage`
 * rejected it. A double that cannot do what the real thing does lets a type
 * pass tests that production can never use.
 */
interface FakeSurface {
  readonly width: number;
  readonly height: number;
  readonly painted: string[];
}

/** Counts paints, so a test can tell a cache hit from a re-render. */
function harness(overrides: Partial<GroundCacheOptions<FakeSurface>> = {}) {
  const painted: string[] = [];
  const cache = new GroundCache<FakeSurface>({
    chunkUnits: 32,
    pixelsPerUnit: 1, // keeps bytesPerChunk a round 32×32×4 = 4,096
    budgetBytes: 1024 * 1024,
    createSurface: (width, height): FakeSurface => ({ width, height, painted: [] }),
    paint: (surface, _bounds, x, y) => {
      painted.push(`${x},${y}`);
      surface.painted.push(`${x},${y}`);
    },
    ...overrides,
  });
  return { cache, painted };
}

// ---------------------------------------------------------------------------

describe('chunk geometry', () => {
  it('sizes a chunk from world units and pixel density', () => {
    const { cache } = harness({ chunkUnits: 64, pixelsPerUnit: 8 });
    expect(cache.chunkPixels).toBe(512);
    expect(cache.bytesPerChunk).toBe(512 * 512 * 4);
  });

  it('maps chunk coordinates to world bounds, including negative ones', () => {
    const { cache } = harness();
    expect(cache.boundsOf(0, 0)).toEqual({ minX: 0, minY: 0, maxX: 32, maxY: 32 });
    expect(cache.boundsOf(-1, 2)).toEqual({ minX: -32, minY: 64, maxX: 0, maxY: 96 });
  });

  it('covers every chunk a view overlaps', () => {
    const { cache } = harness();
    const seen = [...cache.chunksIn({ minX: 0, minY: 0, maxX: 40, maxY: 40 })];
    // 0..40 spans chunks 0 and 1 on both axes.
    expect(seen).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it('handles negative world coordinates without an off-by-one', () => {
    // Math.floor, not truncation. `-1 / 32 | 0` is 0, which would silently skip
    // the chunk covering the origin's negative side and leave a hole in the
    // ground exactly at the city's west and north edges.
    const { cache } = harness();
    const seen = [...cache.chunksIn({ minX: -1, minY: -1, maxX: 1, maxY: 1 })];
    expect(seen).toContainEqual({ x: -1, y: -1 });
    expect(seen).toContainEqual({ x: 0, y: 0 });
    expect(seen).toHaveLength(4);
  });

  it('rejects a nonsense chunk size rather than dividing by zero', () => {
    expect(() => harness({ chunkUnits: 0 })).toThrow(RangeError);
    expect(() => harness({ pixelsPerUnit: -1 })).toThrow(RangeError);
  });
});

describe('caching', () => {
  it('paints once and reuses thereafter', () => {
    const { cache, painted } = harness();

    cache.beginFrame();
    const first = cache.acquire(3, 4);
    cache.endFrame();

    cache.beginFrame();
    const second = cache.acquire(3, 4);
    cache.endFrame();

    expect(painted).toEqual(['3,4']);
    expect(second).toBe(first);
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });

  it('tracks bytes held', () => {
    const { cache } = harness();
    cache.beginFrame();
    cache.acquire(0, 0);
    cache.acquire(1, 0);
    cache.endFrame();
    expect(cache.stats().bytes).toBe(2 * 32 * 32 * 4);
    expect(cache.stats().count).toBe(2);
  });

  it('repaints after invalidation', () => {
    const { cache, painted } = harness();
    cache.beginFrame();
    cache.acquire(0, 0);
    cache.endFrame();

    cache.invalidate();
    expect(cache.stats().bytes).toBe(0);

    cache.beginFrame();
    cache.acquire(0, 0);
    cache.endFrame();
    expect(painted).toEqual(['0,0', '0,0']);
  });
});

describe('eviction stays inside its budget', () => {
  it('drops the least recently used chunk first', () => {
    // Room for exactly three chunks.
    const { cache } = harness({ budgetBytes: 3 * 32 * 32 * 4 });

    // Three separate frames, so nothing is protected by the this-frame rule.
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [2, 0],
    ] as const) {
      cache.beginFrame();
      cache.acquire(x, y);
      cache.endFrame();
    }
    expect(cache.stats().count).toBe(3);

    // Touch the oldest so it is no longer the oldest.
    cache.beginFrame();
    cache.acquire(0, 0);
    cache.endFrame();

    // A fourth chunk must now push out (1,0), not (0,0).
    cache.beginFrame();
    cache.acquire(3, 0);
    cache.endFrame();

    expect(cache.stats().count).toBe(3);
    expect(cache.stats().evictions).toBe(1);

    // (0,0) survived — proved by it not needing a repaint.
    const before = cache.stats().misses;
    cache.beginFrame();
    cache.acquire(0, 0);
    cache.endFrame();
    expect(cache.stats().misses).toBe(before);
  });

  it('never evicts a chunk the current frame is still using', () => {
    // THE bug this class exists to avoid. With room for two chunks and four
    // needed each frame, a naive LRU evicts a chunk and re-renders it on the
    // very next frame — every frame, forever. That is strictly slower than not
    // caching at all, and it reads from outside as an unexplained frame-rate
    // cliff on exactly the machines least able to absorb it.
    const { cache, painted } = harness({ budgetBytes: 2 * 32 * 32 * 4 });

    cache.beginFrame();
    for (let i = 0; i < 4; i += 1) cache.acquire(i, 0);
    cache.endFrame();

    // All four painted once. None was evicted mid-frame and re-acquired.
    expect(painted).toEqual(['0,0', '1,0', '2,0', '3,0']);

    // Re-acquiring within the same frame must still be a hit, not a repaint.
    cache.beginFrame();
    for (let i = 0; i < 4; i += 1) cache.acquire(i, 0);
    for (let i = 0; i < 4; i += 1) cache.acquire(i, 0);
    cache.endFrame();

    // Eight acquires of four chunks, none repainted this frame.
    expect(painted.filter((p) => p === '0,0')).toHaveLength(1);
  });

  it('reports going over budget rather than thrashing silently', () => {
    // The honest signal. C-06 shows this; it means the budget is too small for
    // this screen, not that anything is broken.
    const { cache } = harness({ budgetBytes: 2 * 32 * 32 * 4 });

    cache.beginFrame();
    for (let i = 0; i < 6; i += 1) cache.acquire(i, 0);
    cache.endFrame();

    expect(cache.stats().overBudget).toBe(true);
    expect(cache.stats().bytes).toBeGreaterThan(2 * 32 * 32 * 4);
  });

  it('clears the over-budget flag once the working set fits again', () => {
    const { cache } = harness({ budgetBytes: 4 * 32 * 32 * 4 });

    cache.beginFrame();
    for (let i = 0; i < 8; i += 1) cache.acquire(i, 0);
    cache.endFrame();
    expect(cache.stats().overBudget).toBe(true);

    cache.beginFrame();
    cache.acquire(0, 0);
    cache.endFrame();
    expect(cache.stats().overBudget).toBe(false);
    expect(cache.stats().bytes).toBeLessThanOrEqual(4 * 32 * 32 * 4);
  });

  it('settles instead of repainting forever when the view sits still', () => {
    // The regression that matters over a whole match: a stationary camera must
    // stop painting entirely. If eviction and acquisition fight, this number
    // grows without bound and nothing else in the suite would notice.
    const { cache, painted } = harness({ budgetBytes: 12 * 32 * 32 * 4 });

    for (let frame = 0; frame < 60; frame += 1) {
      cache.beginFrame();
      for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) cache.acquire(x, y);
      cache.endFrame();
    }

    expect(painted).toHaveLength(9);
  });
});

describe('suggestedBudgetBytes', () => {
  it('scales with the screen, not with the city', () => {
    // The finding that shaped this whole file: caching a 1,200-unit city is
    // 400 MB at best. The budget must key off screen area instead.
    const small = suggestedBudgetBytes(1280, 720);
    const large = suggestedBudgetBytes(3840, 2160);
    expect(large).toBeGreaterThan(small * 8);
  });

  it('lands in a sane range for a retina laptop', () => {
    // 3840×2160 backing store — a 1080p panel at DPR 2. At the honest 2×
    // rotation factor this is ~101 MB: large, but it is the real floor for a
    // full-screen ground cache and the LRU keeps it a ceiling rather than a
    // starting point.
    const bytes = suggestedBudgetBytes(3840, 2160);
    const mb = bytes / 1024 / 1024;
    expect(mb).toBeGreaterThan(50);
    expect(mb).toBeLessThan(200);
  });

  it('asks for more when the camera can zoom further out', () => {
    expect(suggestedBudgetBytes(1920, 1080, 0.5)).toBeGreaterThan(
      suggestedBudgetBytes(1920, 1080, 0.9),
    );
  });
});
