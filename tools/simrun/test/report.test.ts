import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { packCity } from '@deadhead/proto';
import { Car, createWorld, fxFromInt, prepareCity, setCar, TICK_HZ } from '@deadhead/sim';

import { botInput } from '../src/bot.js';
import { formatReport, measureRun } from '../src/report.js';

// Relative to the workspace root, which is where vitest runs from. `__dirname`
// does not exist under ESM and the package declares only the node globals it
// actually uses (see `globals.d.ts`), so a repo-relative path is simpler than
// adding `import.meta.url` plumbing for one string.
const CITY = '../../packages/client/assets/cities/01.json';

function run(seconds: number) {
  const json = JSON.parse(readFileSync(CITY, 'utf8')) as Parameters<typeof packCity>[0];
  const city = prepareCity(packCity(json));
  const world = createWorld(20260821, 1, city);
  // Somewhere on the road. G-01 will own cab placement properly.
  setCar(world, 0, Car.X, fxFromInt(-390));
  setCar(world, 0, Car.Y, fxFromInt(250));
  return measureRun(world, city, Math.round(seconds * TICK_HZ), (w) => botInput(w, city));
}

describe('W-04 — City 01 over a 180 s run', () => {
  const report = run(180);

  it('puts traffic on essentially every road segment', () => {
    // "No empty streets." At the previous count of 24 this was 93% — one
    // vehicle every 885 units of road, so a player drove most of a full city
    // crossing without meeting anybody.
    //
    // **Not `toBe(1)`.** Coverage is stochastic: traffic routes are seeded from
    // the city's content hash (ADR 0005), so editing a single building reseeds
    // every vehicle and one segment out of 230 can go unvisited in a 180 s
    // window by luck. The first version of this assertion demanded exactly zero
    // and passed only because one particular city happened to hit all 230 —
    // it failed the next time the buildings changed, with nothing wrong.
    //
    // The claim worth testing is "no street is starved", not "this seed was
    // lucky". By 300 s coverage is 100% on every seed tried.
    expect(report.traffic.coverage, formatReport(report)).toBeGreaterThan(0.98);
    expect(report.traffic.deadRoads).toBeLessThanOrEqual(3);
  });

  it('does not pile them up', () => {
    // "No pile-ups." The mean cannot see this: 64 vehicles on 230 roads
    // averages the same whether they are spread evenly or all in one junction.
    expect(report.traffic.peakOnOneRoad).toBeLessThanOrEqual(10);
  });

  it('keeps traffic moving', () => {
    expect(report.traffic.stalledFraction).toBeLessThan(0.05);
  });

  it('moves demand between districts over the run', () => {
    // "Demand visibly moving between districts." A static hotspot and a
    // migrating one look identical at any single moment, so this is measured as
    // a change in share across quarters of the run, not as a snapshot.
    expect(report.demand.migration, formatReport(report)).toBeGreaterThan(0.25);
  });

  it('gives every district a share of the demand at some point', () => {
    // A district that never spawns anybody is one the routing story never
    // visits. The first version had 2 spawn sites in the north-east against 7
    // in the north-west, and demand cannot migrate INTO a district that has
    // nowhere to arrive — its share read 11% / 27% / 0% / 0%.
    for (const [district, row] of report.demand.shares) {
      expect(Math.max(...row), `${district}: ${formatReport(report)}`).toBeGreaterThan(0.1);
    }
  });

  it('produces enough fares for the measurement to mean anything', () => {
    expect(report.demand.spawns).toBeGreaterThan(40);
  });
});

describe('the report separates the two traffic failures', () => {
  it('reports coverage and peak independently', () => {
    // They fail in opposite directions and one number cannot see both.
    const report = run(30);
    expect(report.traffic).toHaveProperty('coverage');
    expect(report.traffic).toHaveProperty('peakOnOneRoad');
    expect(report.traffic.coverage).toBeGreaterThan(0);
    expect(report.traffic.coverage).toBeLessThanOrEqual(1);
  });

  it('formats a readable summary', () => {
    const text = formatReport(run(10));
    expect(text).toContain('TRAFFIC');
    expect(text).toContain('DEMAND');
    expect(text).toMatch(/migration\s+\d+ percentage points/);
  });
});
