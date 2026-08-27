/**
 * Record the golden replays (`S-14`).
 *
 * ```sh
 * npm run goldens
 * ```
 *
 * **Regenerating is a deliberate act.** These files are the determinism oracle
 * for the whole project: if a golden test fails, the sim changed, and the
 * correct response is to find out why — not to run this. Running it needs an
 * ADR explaining what legitimately changed.
 *
 * Each run is driven by the bot in `bot.ts` rather than by a hand-written input
 * script, because a hand-written script does not stop on kerbs and therefore
 * never exercises pickup, fares or the clocks — which is most of what the
 * goldens exist to protect. The coverage check at the end enforces that: a
 * regeneration that quietly stops delivering anyone fails loudly.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { Input, encodeInputLog, packCity, type CityJson } from '@deadhead/proto';
import {
  Car,
  CarFlags,
  createWorld,
  getCar,
  isDriving,
  isRush,
  prepareCity,
  runLog,
  step,
  type RuntimeCity,
  type World,
} from '@deadhead/sim';

import { botInput } from './bot.js';

const DIRECTORY = 'packages/sim/test/golden';

interface Script {
  readonly seed: number;
  readonly ticks: number;
  readonly note: string;
  readonly at: (world: World, tick: number, city: RuntimeCity) => number;
}

/**
 * The five shapes `S-14` calls for. Seeds are chosen, not arbitrary — a seed
 * that produces a run with no fares in it protects nothing, and several do.
 */
const SCRIPTS: Record<string, Script> = {
  basic: {
    seed: 0x0a11,
    ticks: 3_000,
    note: 'a clean run: the bot works fares for 100 seconds',
    at: (world, _tick, city) => botInput(world, city),
  },
  crash: {
    seed: 0x0c0a,
    ticks: 2_000,
    note: 'drives into buildings on purpose, exercising the S-07 collision path',
    at: (_world, tick) => (tick % 240 < 200 ? Input.Throttle : Input.Throttle | Input.Right),
  },
  bail: {
    seed: 0x0f2a,
    // 12_000, raised from 6_000 on 2026-08-27. The set needs two bails and this
    // scenario is the only one that produces any now: the 1.35x speed and the
    // 4.5-unit pickup radius mean the bot reaches passengers before their
    // patience runs out, so `endurance` — which used to supply the rest — no
    // longer bails at all. Each bail cycle costs one meterPatience (75 s) plus
    // travel, so 200 s fitted one and 400 s fits several.
    ticks: 12_000,
    note: 'collects a Meter passenger and then refuses to move, so their patience runs out',
    at: (world, _tick, city) => {
      // Stop the moment a Meter passenger is aboard. A fixed cutoff tick does
      // not work: whether the cab happens to be carrying anyone at tick 900 is
      // a property of the seed, and the first attempt delivered instead.
      // A Rush passenger never bails, so keep driving until it is a Meter.
      const carried = getCar(world, 0, Car.CarriedPassenger);
      if (carried >= 0 && !isRush(world, carried)) return 0;
      return botInput(world, city);
    },
  },
  rush: {
    seed: 0x0f5a,
    ticks: 4_000,
    note: 'the bot driving with the handbrake stabbed in, so fares decay while it slides',
    at: (world, tick, city) => botInput(world, city) | (tick % 211 < 24 ? Input.Handbrake : 0),
  },
  endurance: {
    seed: 3,
    // 16_000, raised from 10_000 on 2026-08-27, because the run got LONGER
    // rather than the scenario getting weaker. Measured with the new tuning:
    // the bot carries a passenger 63% of the time, and the deadhead bank only
    // drains while empty — so 180 s of bank stretches to ~490 s of wall clock
    // and elimination lands around tick 14_700. At 10_000 the scenario simply
    // stopped before the thing it exists to cover.
    ticks: 16_000,
    note: 'sixteen thousand ticks of real play, through crash, deliveries and elimination',
    at: (world, _tick, city) => botInput(world, city),
  },
};

interface Coverage {
  deliveries: number;
  bails: number;
  crashed: boolean;
  eliminated: boolean;
}

/** Drive the sim with a per-tick input function, recording what it produced. */
function record(city: RuntimeCity, script: Script): { ticks: Uint8Array; coverage: Coverage } {
  const ticks = new Uint8Array(script.ticks);
  const coverage: Coverage = { deliveries: 0, bails: 0, crashed: false, eliminated: false };

  let world = createWorld(script.seed, 1, city);
  let carrying = -1;

  for (let tick = 0; tick < script.ticks; tick += 1) {
    const input = script.at(world, tick, city) & 0x3f;
    ticks[tick] = input;

    const deliveriesBefore = getCar(world, 0, Car.Deliveries);
    world = step(world, [input]);

    const carried = getCar(world, 0, Car.CarriedPassenger);
    if (carrying >= 0 && carried < 0 && getCar(world, 0, Car.Deliveries) === deliveriesBefore) {
      coverage.bails += 1;
    }
    carrying = carried;

    if ((getCar(world, 0, Car.Flags) & CarFlags.Crashed) !== 0) coverage.crashed = true;
    if (!isDriving(world, 0)) coverage.eliminated = true;
  }

  coverage.deliveries = getCar(world, 0, Car.Deliveries);
  return { ticks, coverage };
}

function main(): void {
  const cityJson = JSON.parse(readFileSync(`${DIRECTORY}/city.json`, 'utf8')) as CityJson;
  const city = prepareCity(packCity(cityJson));

  const runs: Record<string, unknown> = {};
  const logBytes: Record<string, number[]> = {};
  const total: Coverage = { deliveries: 0, bails: 0, crashed: false, eliminated: false };

  for (const [name, script] of Object.entries(SCRIPTS)) {
    const { ticks, coverage } = record(city, script);
    const log = {
      seed: script.seed,
      cityHash: city.packed.contentHash,
      startedAtMs: 1_800_000_000_000,
      ticks,
    };

    const encoded = encodeInputLog(log);
    writeFileSync(`${DIRECTORY}/${name}.log`, encoded);
    logBytes[name] = Array.from(encoded);

    const result = runLog(log, city);
    runs[name] = {
      note: script.note,
      seed: script.seed,
      ticks: result.ticks,
      bytes: encoded.length,
      score: result.score,
      deliveries: result.deliveries,
      hashInterval: result.hashInterval,
      hashTrail: result.hashTrail,
    };

    total.deliveries += coverage.deliveries;
    total.bails += coverage.bails;
    total.crashed ||= coverage.crashed;
    total.eliminated ||= coverage.eliminated;

    process.stdout.write(
      `${name.padEnd(10)} ${String(encoded.length).padStart(5)}B  ` +
        `${String(result.ticks).padStart(6)} ticks  score ${String(result.score).padStart(6)}  ` +
        `deliveries ${coverage.deliveries}  bails ${coverage.bails}  ` +
        `crash ${coverage.crashed ? 'Y' : 'n'}  eliminated ${coverage.eliminated ? 'Y' : 'n'}\n`,
    );
  }

  // A golden set that exercises none of the game is worse than none at all: it
  // is green, it looks like coverage, and it protects a car driving in circles.
  const missing: string[] = [];
  if (total.deliveries < 5) missing.push(`deliveries (${total.deliveries})`);
  if (total.bails < 2) missing.push(`bails (${total.bails})`);
  if (!total.crashed) missing.push('a crash');
  if (!total.eliminated) missing.push('an elimination');
  if (missing.length > 0) {
    throw new Error(`golden set does not cover: ${missing.join(', ')}`);
  }

  // The same bytes again, as JSON.
  //
  // The golden tests run in `workerd` as well as in node, and `workerd` has no
  // filesystem — so they cannot read the .log files. Vite has no import suffix
  // that yields binary either. A JSON array of bytes imports identically
  // everywhere and needs no codec. The .log files remain the artefact `simrun`
  // reads, and a node-side test asserts the two agree, so there is one source
  // of truth rather than two that can drift.
  writeFileSync(
    `${DIRECTORY}/logs.json`,
    `${JSON.stringify(
      {
        _comment:
          'GOLDEN. The same bytes as the .log files beside this, as JSON so the tests can ' +
          'import them under workerd, which has no filesystem. Regenerate with `npm run goldens`.',
        logs: logBytes,
      },
      null,
      1,
    )}\n`,
  );

  writeFileSync(
    `${DIRECTORY}/manifest.json`,
    `${JSON.stringify(
      {
        _comment:
          'GOLDEN. Recorded scores and hash trails for the logs beside this file. NEVER edit a ' +
          'value to make a test pass: if a golden fails, the sim changed, and the job is to find ' +
          'out why. Regenerating needs an ADR — run `npm run goldens`. See the S-14 note in TASKS.md.',
        city: 'city.json',
        cityHash: city.packed.contentHash,
        coverage: total,
        runs,
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(
    `\ncity ${city.packed.contentHash.toString(16)} — covered ` +
      `${total.deliveries} deliveries, ${total.bails} bail(s), a crash and an elimination\n`,
  );
}

main();
