import { describe, expect, it } from 'vitest';

import { packCity, validateCity } from '@deadhead/proto';
import { prepareCity } from '@deadhead/sim';

import { audit, isPlayable, formatFindings } from '../src/audit.js';
import { EXTENT, assertCutIntact, buildCity01 } from '../src/cities/city-01.js';

const city = buildCity01();
const findings = audit(city);

describe('City 01 is shippable', () => {
  it('has no audit errors', () => {
    expect(isPlayable(findings), formatFindings(findings)).toBe(true);
  });

  it('has no warnings either', () => {
    // Not a stylistic preference. Every rule here fires only on something a
    // player would notice, so a warning left standing in the shipped city is
    // one nobody will ever look at again.
    expect(formatFindings(findings)).toBe('No problems found.');
  });

  it("loads through the game's own pipeline", () => {
    const packed = packCity(city);
    validateCity(packed);
    const runtime = prepareCity(packed);
    expect(runtime.nav.nodeExitStart.length).toBe(city.nodes.length + 1);
  });

  it('fits inside its stated extent', () => {
    for (const node of city.nodes) {
      expect(Math.abs(node.x)).toBeLessThanOrEqual(EXTENT);
      expect(Math.abs(node.y)).toBeLessThanOrEqual(EXTENT);
    }
  });
});

describe('the design holds', () => {
  it('keeps the Cut intact — no street crosses it but a bridge', () => {
    // The one piece of City 01's design a general-purpose audit cannot know to
    // check. Carving fills whatever the streets leave, so the Cut is a barrier
    // only because nothing is drawn through it — an invariant held by omission,
    // and those rot. A stray north-south street through y=115 would delete the
    // feature the whole city routes around and every audit rule would pass.
    expect(assertCutIntact(city)).toEqual([]);
  });

  it('has one-way streets, and they form a cycle', () => {
    // The couplet in the Warrens. `audit`'s strong-connectivity rule is what
    // proves the cycle; this only proves the one-ways exist at all, because a
    // city that quietly lost them would still pass everything else.
    const oneWays = city.edges.filter((e) => ((e.flags ?? 0) & 1) !== 0);
    expect(oneWays.length).toBeGreaterThan(4);
  });

  it('gives every district a landmark to navigate by', () => {
    // DESIGN.md §2.4: no floating destination arrow, so these are the only
    // thing telling a player which quarter they are in.
    expect(city.landmarks).toHaveLength(5);
    for (const landmark of city.landmarks) {
      expect(landmark.name, JSON.stringify(landmark)).toBeDefined();
    }

    const quadrant = (p: { x: number; y: number }): string =>
      `${p.x < 0 ? 'W' : 'E'}${p.y < 0 ? 'N' : 'S'}`;
    // Four quarters covered, plus the one on the Crease at the centre.
    expect(new Set(city.landmarks.map(quadrant)).size).toBe(4);
  });

  it('phases demand so the busy quarter migrates across a run', () => {
    // DESIGN.md §2.2 wants the routing story to change while you play. Four
    // anchors all peaking together would be one static hotspot.
    const phases = city.demandAnchors.map((a) => a.phase ?? 0);
    expect(new Set(phases).size).toBe(phases.length);
    expect(Math.max(...phases) - Math.min(...phases)).toBeGreaterThan(128);
  });

  it('keeps every spawn far enough from every destination to be a fare', () => {
    // S-09 picks a destination uniformly at random and INDEPENDENTLY of the
    // spawn, so any pair can come up. A close pair is a fare that pays the base
    // rate for no driving — the S-10 finding, as a property of the city.
    for (const s of city.spawns) {
      for (const d of city.destinations) {
        expect(Math.hypot(s.x - d.x, s.y - d.y)).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it('names its streets, so W-06 has something to put on a sign', () => {
    const named = city.nodes.filter((n) => n.name !== undefined);
    expect(named.length).toBeGreaterThan(20);
    for (const node of named) expect(city.names[node.name!]).toBeDefined();
  });
});

describe('the road network', () => {
  it('is strongly connected — every junction can be reached and left', () => {
    expect(findings.filter((f) => f.rule === 'unreachable')).toEqual([]);
  });

  it('has no road running through a building', () => {
    // 27 of these existed before the buildings were carved from the streets
    // rather than placed beside them. The city looked normal and was
    // substantially impassable.
    expect(findings.filter((f) => f.rule === 'road-through-building')).toEqual([]);
  });

  it('has no crossing without a junction', () => {
    // Five of these existed before `weld()`: the Crease and the Yard Cut sailed
    // over the Yards grid like overpasses, and there is no elevation in a 2D
    // sim.
    expect(findings.filter((f) => f.rule === 'crossing-without-junction')).toEqual([]);
  });

  it('is big enough to be a city and small enough to learn', () => {
    expect(city.nodes.length).toBeGreaterThan(80);
    expect(city.edges.length).toBeGreaterThan(150);
    expect(city.buildings.length).toBeGreaterThan(50);
  });
});
