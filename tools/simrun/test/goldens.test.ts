import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { decodeInputLog, packCity, type CityJson } from '@deadhead/proto';
import { prepareCity, runLog } from '@deadhead/sim';

import logsJson from '../../../packages/sim/test/golden/logs.json' with { type: 'json' };
import manifest from '../../../packages/sim/test/golden/manifest.json' with { type: 'json' };

/**
 * The golden logs exist in two forms and this is what stops them drifting.
 *
 * - `*.log` — the binary artefact `simrun` reads, and what a real submission
 *   looks like on the wire.
 * - `logs.json` — the same bytes as a JSON array, because the sim's golden
 *   tests run under `workerd`, which has no filesystem, and Vite has no import
 *   suffix that yields binary.
 *
 * Two representations of one thing is a drift risk, so this asserts they are
 * byte-identical. It lives here rather than in `packages/sim` because it needs
 * to read files, which the sim's tests deliberately cannot do.
 */

// Relative to this package, since Vitest runs with the workspace as its cwd.
const DIRECTORY = '../../packages/sim/test/golden';
const logs = logsJson.logs as Record<string, number[]>;

describe('the two golden representations agree', () => {
  it.each(Object.keys(logs))('%s.log matches logs.json byte for byte', (name) => {
    const onDisk = new Uint8Array(readFileSync(`${DIRECTORY}/${name}.log`));
    expect(Array.from(onDisk)).toEqual(logs[name]);
  });

  it('covers every log the manifest describes', () => {
    expect(Object.keys(logs).sort()).toEqual(Object.keys(manifest.runs).sort());
  });
});

describe('replaying from disk', () => {
  const city = prepareCity(
    packCity(JSON.parse(readFileSync(`${DIRECTORY}/city.json`, 'utf8')) as CityJson),
  );

  it('reproduces the manifest from the binary logs, not just the JSON ones', () => {
    // The path `simrun` and `B-08` actually take: read bytes, decode, replay.
    for (const [name, expected] of Object.entries(manifest.runs)) {
      const bytes = new Uint8Array(readFileSync(`${DIRECTORY}/${name}.log`));
      const result = runLog(decodeInputLog(bytes), city);

      expect(result.score, name).toBe(expected.score);
      expect(result.deliveries, name).toBe(expected.deliveries);
      expect(result.hashTrail, name).toEqual(expected.hashTrail);
    }
  });

  it('finds the city beside the log, which is the fixture convention', () => {
    // A log and the city it was played on are only meaningful together, so
    // `simrun` defaults to `city.json` in the log's own directory.
    expect(city.packed.contentHash).toBe(manifest.cityHash);
  });
});
