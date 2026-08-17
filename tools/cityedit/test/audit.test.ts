import { describe, expect, it } from 'vitest';

import { EdgeFlags, emptyCityJson, type CityJson } from '@deadhead/proto';

import {
  audit,
  distanceToNearestRoad,
  distanceToSegment,
  formatFindings,
  isPlayable,
  pointInBox,
  stronglyConnectedComponents,
} from '../src/audit.js';

/**
 * A minimal but genuinely playable city: a square block of four junctions,
 * two-way throughout, with one spawn and one distant destination.
 */
function squareCity(overrides: Partial<CityJson> = {}): CityJson {
  return {
    ...emptyCityJson('square'),
    nodes: [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 0, y: 200 },
    ],
    edges: [
      { a: 0, b: 1, width: 8 },
      { a: 1, b: 2, width: 8 },
      { a: 2, b: 3, width: 8 },
      { a: 3, b: 0, width: 8 },
    ],
    spawns: [{ x: 10, y: 4 }],
    destinations: [{ x: 190, y: 196 }],
    ...overrides,
  };
}

const rules = (city: CityJson, options = {}): string[] =>
  audit(city, options).map((finding) => finding.rule);

// ---------------------------------------------------------------------------

describe('geometry', () => {
  it('treats a box edge as inside', () => {
    const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(pointInBox({ x: 5, y: 5 }, box)).toBe(true);
    expect(pointInBox({ x: 0, y: 10 }, box)).toBe(true);
    expect(pointInBox({ x: 11, y: 5 }, box)).toBe(false);
  });

  it('measures to the segment, not the infinite line', () => {
    // The distinction that matters: a spawn beyond the end of a street is far
    // from that street. Measuring to the infinite line would call it adjacent
    // and pass a spawn a cab cannot reach.
    const beyondTheEnd = { x: 200, y: 0 };
    expect(distanceToSegment(beyondTheEnd, 0, 0, 100, 0)).toBeCloseTo(100, 9);

    // Perpendicular, within the span — here the two agree.
    expect(distanceToSegment({ x: 50, y: 30 }, 0, 0, 100, 0)).toBeCloseTo(30, 9);
  });

  it('handles a zero-length segment without dividing by zero', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, 0, 0, 0, 0)).toBeCloseTo(5, 9);
  });

  it('reports Infinity when there are no roads at all', () => {
    expect(distanceToNearestRoad({ x: 0, y: 0 }, emptyCityJson())).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('a good city passes', () => {
  it('reports nothing on a well-formed square', () => {
    expect(audit(squareCity())).toEqual([]);
    expect(isPlayable(audit(squareCity()))).toBe(true);
  });

  it('never throws on a half-authored city', () => {
    // The editor calls this constantly, on cities that are mid-edit and
    // therefore expected to be broken. Throwing would make it unusable — and
    // is exactly what separates this from proto's validateCity.
    expect(() => audit(emptyCityJson())).not.toThrow();
    expect(() => audit(squareCity({ edges: [] }))).not.toThrow();
    expect(() => audit(squareCity({ nodes: [] }))).not.toThrow();
  });
});

describe('a city that cannot produce a fare', () => {
  it('flags an empty city on every count', () => {
    const found = rules(emptyCityJson());
    expect(found).toContain('no-roads');
    expect(found).toContain('no-spawns');
    expect(found).toContain('no-destinations');
    expect(isPlayable(audit(emptyCityJson()))).toBe(false);
  });

  it('flags a city with roads but nowhere to pick up', () => {
    expect(rules(squareCity({ spawns: [] }))).toContain('no-spawns');
  });
});

describe('points somewhere impossible', () => {
  it('flags a destination inside a building', () => {
    const city = squareCity({
      buildings: [{ minX: 180, minY: 180, maxX: 220, maxY: 220 }],
    });
    const found = audit(city).find((f) => f.rule === 'point-inside-building');
    expect(found?.severity).toBe('error');
    expect(found?.subject).toEqual({ kind: 'destination', index: 0 });
  });

  it('flags a spawn a cab cannot reach', () => {
    const city = squareCity({ spawns: [{ x: 100, y: 100 }] }); // dead centre of the block
    const found = audit(city).find((f) => f.rule === 'no-road-access');
    expect(found?.severity).toBe('error');
    expect(found?.message).toMatch(/cannot reach/);
  });

  it('allows a spawn on the pavement beside a road', () => {
    // Passengers stand on the kerb, not in the carriageway, so some distance is
    // correct. Too strict a rule would reject every properly authored spawn.
    expect(rules(squareCity({ spawns: [{ x: 100, y: 6 }] }))).not.toContain('no-road-access');
  });

  it('only warns about a landmark in a building, and never about its road access', () => {
    // A landmark is a silhouette to navigate BY (DESIGN.md §2.4). Nobody drives
    // to it, and it being a building is the normal case rather than an error.
    const city = squareCity({
      landmarks: [{ x: 100, y: 100 }],
      buildings: [{ minX: 80, minY: 80, maxX: 120, maxY: 120 }],
    });
    const found = audit(city);
    expect(found.find((f) => f.rule === 'point-inside-building')?.severity).toBe('warning');
    expect(found.map((f) => f.rule)).not.toContain('no-road-access');
  });
});

describe('fares that are over before they start', () => {
  it('flags a destination on the kerb the passenger is standing on', () => {
    // S-10's finding. The passenger is delivered the instant they get in, for
    // the base fare and no driving. The sim is behaving correctly; the CITY is
    // wrong, which is why the rule lives here and not in the sim.
    const city = squareCity({
      spawns: [{ x: 10, y: 4 }],
      destinations: [{ x: 14, y: 4 }],
    });
    const found = audit(city).find((f) => f.rule === 'fare-too-short');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('warning');
    expect(found?.message).toMatch(/no driving/);
  });

  it('accepts a fare that is worth driving', () => {
    expect(rules(squareCity())).not.toContain('fare-too-short');
  });

  it('takes the minimum distance as an option', () => {
    expect(rules(squareCity(), { minFareDistance: 1000 })).toContain('fare-too-short');
  });
});

describe('strong connectivity is the rule that earns its keep', () => {
  it('catches a one-way trap that an undirected check calls connected', () => {
    // THE case this file exists for. Node 4 is reached by a one-way spur and
    // has no way back. Treat the graph as undirected and it looks perfectly
    // attached — every node touches a road. A driver who turns in is stuck
    // there for the rest of the run.
    const city = squareCity({
      nodes: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 200 },
        { x: 0, y: 200 },
        { x: 300, y: 100 },
      ],
      edges: [
        { a: 0, b: 1, width: 8 },
        { a: 1, b: 2, width: 8 },
        { a: 2, b: 3, width: 8 },
        { a: 3, b: 0, width: 8 },
        { a: 1, b: 4, width: 8, flags: EdgeFlags.OneWay },
      ],
    });

    const found = audit(city);
    const unreachable = found.filter((f) => f.rule === 'unreachable');
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]?.subject).toEqual({ kind: 'node', index: 4 });
    expect(unreachable[0]?.message).toMatch(/one-way/);

    // And it is an error, not a warning — the city is not shippable like this.
    expect(isPlayable(found)).toBe(false);
  });

  it('accepts the same spur when it is two-way', () => {
    const city = squareCity({
      nodes: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 200 },
        { x: 0, y: 200 },
        { x: 300, y: 100 },
      ],
      edges: [
        { a: 0, b: 1, width: 8 },
        { a: 1, b: 2, width: 8 },
        { a: 2, b: 3, width: 8 },
        { a: 3, b: 0, width: 8 },
        { a: 1, b: 4, width: 8 },
      ],
    });
    expect(rules(city)).not.toContain('unreachable');
  });

  it('accepts a one-way loop, which is the whole point of one-ways', () => {
    // A ring of one-ways all pointing the same way is strongly connected and is
    // exactly what W-03 wants for route knowledge. A rule that rejected it
    // would ban the feature it exists to support.
    const city = squareCity({
      edges: [
        { a: 0, b: 1, width: 8, flags: EdgeFlags.OneWay },
        { a: 1, b: 2, width: 8, flags: EdgeFlags.OneWay },
        { a: 2, b: 3, width: 8, flags: EdgeFlags.OneWay },
        { a: 3, b: 0, width: 8, flags: EdgeFlags.OneWay },
      ],
    });
    expect(rules(city)).not.toContain('unreachable');
    expect(isPlayable(audit(city))).toBe(true);
  });

  it('catches a genuinely detached island too', () => {
    const city = squareCity({
      nodes: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 200 },
        { x: 0, y: 200 },
        { x: 900, y: 900 },
        { x: 950, y: 950 },
      ],
      edges: [
        { a: 0, b: 1, width: 8 },
        { a: 1, b: 2, width: 8 },
        { a: 2, b: 3, width: 8 },
        { a: 3, b: 0, width: 8 },
        { a: 4, b: 5, width: 8 },
      ],
    });
    const unreachable = audit(city).filter((f) => f.rule === 'unreachable');
    expect(unreachable.map((f) => f.subject?.index).sort()).toEqual([4, 5]);
  });

  it('groups mutually reachable nodes into one component', () => {
    const component = stronglyConnectedComponents(squareCity());
    expect(new Set(component)).toHaveLength(1);
  });

  it('separates the two sides of a one-way spur', () => {
    const city = squareCity({
      nodes: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      edges: [{ a: 0, b: 1, width: 8, flags: EdgeFlags.OneWay }],
    });
    const component = stronglyConnectedComponents(city);
    expect(component[0]).not.toBe(component[1]);
  });

  it('does not blow the stack on a long chain', () => {
    // Iterative DFS, because a long street is a deep graph and a recursive
    // walk would overflow somewhere around a few thousand junctions.
    const nodes = Array.from({ length: 20_000 }, (_, i) => ({ x: i * 10, y: 0 }));
    const edges = nodes.slice(1).map((_, i) => ({ a: i, b: i + 1, width: 8 }));
    const city = squareCity({ nodes, edges, spawns: [], destinations: [] });

    expect(() => stronglyConnectedComponents(city)).not.toThrow();
    expect(stronglyConnectedComponents(city)).toHaveLength(20_000);
  });
});

describe('dead ends and orphans', () => {
  it('warns about a dead end rather than rejecting it', () => {
    // A cul-de-sac is a legitimate authoring choice; NPC traffic just handles
    // it badly. Warning, not error.
    const city = squareCity({
      nodes: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 200 },
        { x: 0, y: 200 },
        { x: 300, y: 100 },
      ],
      edges: [
        { a: 0, b: 1, width: 8 },
        { a: 1, b: 2, width: 8 },
        { a: 2, b: 3, width: 8 },
        { a: 3, b: 0, width: 8 },
        { a: 1, b: 4, width: 8 },
      ],
    });
    const found = audit(city).find((f) => f.rule === 'dead-end');
    expect(found?.severity).toBe('warning');
    expect(found?.subject).toEqual({ kind: 'node', index: 4 });
  });

  it('flags a junction with no roads attached', () => {
    const city = squareCity({
      nodes: [...squareCity().nodes, { x: 500, y: 500 }],
    });
    expect(rules(city)).toContain('orphan-node');
  });
});

describe('demand anchors and names', () => {
  it('rejects a zero-radius anchor', () => {
    expect(rules(squareCity({ demandAnchors: [{ x: 50, y: 50, radius: 0 }] }))).toContain(
      'anchor-no-radius',
    );
  });

  it('rejects a phase outside a run', () => {
    const city = squareCity({ demandAnchors: [{ x: 50, y: 50, radius: 40, phase: 300 }] });
    expect(rules(city)).toContain('anchor-phase-range');
  });

  it('rejects a name index that points past the end of the table', () => {
    // W-06's signage reads these. An out-of-range index is a blank street sign
    // in the shipped game, which nothing else would catch.
    expect(rules(squareCity({ spawns: [{ x: 10, y: 4, name: 7 }] }))).toContain('bad-name-index');
  });

  it('accepts a name index that resolves', () => {
    const city = squareCity({ names: ['Cannon Street'], spawns: [{ x: 10, y: 4, name: 0 }] });
    expect(rules(city)).not.toContain('bad-name-index');
  });
});

describe('reporting', () => {
  it('puts errors before warnings', () => {
    const city = squareCity({
      nodes: [...squareCity().nodes, { x: 300, y: 100 }],
      edges: [...squareCity().edges, { a: 1, b: 4, width: 8 }],
      destinations: [{ x: 14, y: 4 }], // too close to the spawn: a warning
      demandAnchors: [{ x: 0, y: 0, radius: -1 }], // an error
    });
    const severities = audit(city).map((f) => f.severity);
    expect(severities.indexOf('warning')).toBeGreaterThan(-1);
    expect(severities.lastIndexOf('error')).toBeLessThan(severities.indexOf('warning'));
  });

  it('formats a readable summary', () => {
    const text = formatFindings(audit(emptyCityJson()));
    expect(text).toMatch(/^\d+ errors, \d+ warnings/);
    expect(text).toContain('no-spawns');
  });

  it('says so plainly when there is nothing wrong', () => {
    expect(formatFindings(audit(squareCity()))).toBe('No problems found.');
  });
});
