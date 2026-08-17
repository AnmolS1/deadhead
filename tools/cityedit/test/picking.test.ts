import { describe, expect, it } from 'vitest';

import { emptyCityJson, type CityJson } from '@deadhead/proto';

import { pick, snap, toleranceForZoom } from '../src/picking.js';

function city(overrides: Partial<CityJson> = {}): CityJson {
  return {
    ...emptyCityJson('pick'),
    nodes: [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ],
    edges: [{ a: 0, b: 1, width: 8 }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('pick priority', () => {
  it('selects a junction over the roads that meet there', () => {
    // The ordering that matters most. A junction sits ON its roads, so a
    // containment test alone would select the road — and you can always click
    // the road further along, but you can never click the junction anywhere
    // else. Getting this backwards is a tool that fights you all afternoon.
    expect(pick(city(), { x: 0, y: 0 }, 6)?.kind).toBe('node');
  });

  it('selects the road away from any junction', () => {
    const found = pick(city(), { x: 100, y: 0 }, 6);
    expect(found?.kind).toBe('edge');
    expect(found?.index).toBe(0);
  });

  it('selects a marker over the road it stands beside', () => {
    const found = pick(city({ spawns: [{ x: 100, y: 5 }] }), { x: 100, y: 5 }, 6);
    expect(found?.kind).toBe('spawn');
  });

  it('selects a landmark over the building it sits in', () => {
    // Buildings are last precisely because they are large enough to swallow
    // every click inside their footprint.
    const found = pick(
      city({
        landmarks: [{ x: 500, y: 500 }],
        buildings: [{ minX: 400, minY: 400, maxX: 600, maxY: 600 }],
      }),
      { x: 500, y: 500 },
      6,
    );
    expect(found?.kind).toBe('landmark');
  });

  it('selects the smaller of two overlapping buildings', () => {
    // So a prop placed on a block stays selectable rather than being buried.
    const found = pick(
      city({
        buildings: [
          { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
          { minX: 400, minY: 400, maxX: 420, maxY: 420 },
        ],
      }),
      { x: 410, y: 410 },
      6,
    );
    expect(found).toEqual({ kind: 'building', index: 1, distance: 0 });
  });

  it('returns null on empty space', () => {
    expect(pick(city(), { x: 900, y: 900 }, 6)).toBeNull();
    expect(pick(emptyCityJson(), { x: 0, y: 0 }, 6)).toBeNull();
  });
});

describe('pick geometry', () => {
  it('counts the carriageway width, not just the centreline', () => {
    // A click anywhere on the road surface should select the road. Width 8
    // means 4 units either side of the centre, plus the caller's tolerance.
    expect(pick(city(), { x: 100, y: 3 }, 0)?.kind).toBe('edge');
    expect(pick(city(), { x: 100, y: 20 }, 0)).toBeNull();
  });

  it('respects the tolerance it is given', () => {
    // At (0, 7): the junction is 7 away, the road's reach is width/2 + tolerance.
    expect(pick(city(), { x: 0, y: 7 }, 4)?.kind).toBe('edge'); // 7 <= 4 + 4, but 7 > 4
    expect(pick(city(), { x: 0, y: 7 }, 8)?.kind).toBe('node'); // now the junction reaches
    expect(pick(city(), { x: 0, y: 7 }, 1)).toBeNull(); // reach is only 5
  });

  it('does not select a road beyond its end', () => {
    // Segment, not infinite line. A click 300 units past the end of a street is
    // not a click on that street.
    expect(pick(city(), { x: 500, y: 0 }, 6)).toBeNull();
  });

  it('picks the nearest of several candidates of the same kind', () => {
    const found = pick(
      city({
        spawns: [
          { x: 100, y: 0 },
          { x: 102, y: 0 },
        ],
      }),
      { x: 101.6, y: 0 },
      6,
    );
    expect(found?.index).toBe(1);
  });

  it('is stable — the same click always returns the same thing', () => {
    // A picker whose result varies under an identical click is one nobody can
    // build a habit around. Ties break by distance, then lowest index.
    const target = city({
      spawns: [
        { x: 100, y: 0 },
        { x: 100, y: 0 },
      ],
    });
    const first = pick(target, { x: 100, y: 0 }, 6);
    for (let i = 0; i < 20; i += 1) {
      expect(pick(target, { x: 100, y: 0 }, 6)).toEqual(first);
    }
    expect(first?.index).toBe(0);
  });
});

describe('snap', () => {
  it('snaps to an existing junction first of all', () => {
    // THE rule that prevents a whole class of broken city. Snapping to the grid
    // instead would leave a new junction one unit from the one already there —
    // two roads crossing with NO connection between them. It looks correct on
    // screen and produces an `unreachable` finding whose cause is invisible.
    const result = snap(city(), { x: 3, y: 2 });
    expect(result.to).toBe('node');
    expect(result.index).toBe(0);
    expect(result.point).toEqual({ x: 0, y: 0 });
  });

  it('prefers the nearer junction when two are in range', () => {
    const result = snap(
      city({
        nodes: [
          { x: 0, y: 0 },
          { x: 14, y: 0 },
        ],
      }),
      { x: 10, y: 0 },
    );
    expect(result.index).toBe(1);
  });

  it('snaps onto a road when no junction is near', () => {
    const result = snap(city(), { x: 100, y: 3 });
    expect(result.to).toBe('edge');
    expect(result.index).toBe(0);
    expect(result.point).toEqual({ x: 100, y: 0 });
  });

  it('rounds a road snap to whole units', () => {
    // The format stores whole units, and a junction at x = 41.37219 is a
    // nuisance in a JSON file a human has to read.
    const result = snap(city(), { x: 41.372, y: 2 });
    expect(Number.isInteger(result.point.x)).toBe(true);
    expect(Number.isInteger(result.point.y)).toBe(true);
  });

  it('falls back to the grid in open space', () => {
    const result = snap(city(), { x: 507, y: 493 }, { grid: 10 });
    expect(result.to).toBe('grid');
    expect(result.point).toEqual({ x: 510, y: 490 });
  });

  it('rounds to whole units when the grid is off', () => {
    const result = snap(city(), { x: 507.4, y: 492.6 }, { grid: 0 });
    expect(result.to).toBe('none');
    expect(result.point).toEqual({ x: 507, y: 493 });
  });

  it('does not snap to a junction that is far away', () => {
    expect(snap(city(), { x: 800, y: 800 }).to).toBe('grid');
  });

  it('takes its radii as options', () => {
    expect(snap(city(), { x: 60, y: 0 }, { nodeRadius: 100 }).to).toBe('node');
    // Off the centreline, so tight radii fall through to the grid. Testing this
    // at (60, 0) would not work: that point lies exactly ON the road, so even a
    // 1-unit edge radius catches it — correctly.
    expect(snap(city(), { x: 60, y: 20 }, { nodeRadius: 1, edgeRadius: 1 }).to).toBe('grid');
  });
});

describe('toleranceForZoom', () => {
  it('converts a pixel radius into world units', () => {
    // 10 px at 10 device px per world unit is 1 world unit.
    expect(toleranceForZoom(10, 1, 10)).toBeCloseTo(1, 9);
  });

  it('widens as the view zooms out', () => {
    // The cursor is always the same size on screen, so the world-space radius
    // must grow when zoomed out. A fixed WORLD tolerance would make picking
    // feel progressively less accurate — which reads as a broken tool rather
    // than as a constant radius behaving correctly.
    const near = toleranceForZoom(10, 1, 10);
    const far = toleranceForZoom(10, 0.5, 10);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeCloseTo(near * 2, 9);
  });

  it('does not divide by zero on a degenerate view', () => {
    expect(Number.isFinite(toleranceForZoom(10, 0, 10))).toBe(true);
  });
});
