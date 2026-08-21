/**
 * `simrun` — replay an input log from the command line.
 *
 * ```sh
 * npm run simrun -- packages/sim/test/golden/basic.log
 * npm run simrun -- --city path/to/city.json --interval 50 run.log
 * ```
 *
 * The same `runLog()` the replay validator uses, with a file reader and a
 * printer around it. That is deliberate: if this and `B-08` ever disagreed, one
 * of them would be lying about a leaderboard.
 *
 * A log names the city it was played on by content hash, so this refuses to
 * replay one against the wrong city rather than producing a plausible wrong
 * score.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { decodeInputLog, packCity, type CityJson } from '@deadhead/proto';
import {
  Car,
  TICK_HZ,
  createWorld,
  prepareCity,
  runLog,
  setCar,
  type RuntimeCity,
} from '@deadhead/sim';

import { botInput } from './bot.js';
import { formatReport, measureRun } from './report.js';

interface Args {
  readonly logPath: string | undefined;
  readonly cityPath: string | undefined;
  readonly hashInterval: number | undefined;
  readonly quiet: boolean;
  /** `--report=traffic,demand` — measure a city rather than replay a log. */
  readonly report: readonly string[] | undefined;
  /** `--seconds N` — how long to drive when reporting. */
  readonly seconds: number;
}

function parseArgs(argv: readonly string[]): Args {
  let logPath: string | undefined;
  let cityPath: string | undefined;
  let hashInterval: number | undefined;
  let quiet = false;
  let report: readonly string[] | undefined;
  let seconds = 180;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--city') {
      i += 1;
      cityPath = argv[i] as string;
    } else if (arg === '--interval') {
      i += 1;
      hashInterval = Number(argv[i]);
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg.startsWith('--report')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : 'traffic,demand';
      report = value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    } else if (arg === '--seconds') {
      i += 1;
      seconds = Number(argv[i]);
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      logPath = arg;
    }
  }

  // A report measures a city by driving it, so it needs no log — that is the
  // whole point of `W-04`'s verify line, which names no file.
  if (logPath === undefined && report === undefined) {
    throw new Error(
      'usage: simrun [--city city.json] [--interval N] [--quiet] <log>\n' +
        '       simrun --report[=traffic,demand] [--city city.json] [--seconds N]',
    );
  }
  return { logPath, cityPath, hashInterval, quiet, report, seconds };
}

/**
 * Find the city for a log.
 *
 * `--city` wins. Otherwise look for `city.json` beside the log, which is the
 * convention the golden fixtures use — a log and the city it was played on are
 * only meaningful together.
 */
function loadCity(args: Args): CityJson {
  // `--report` names a city and no log, so there is no log directory to look
  // beside — the explicit path is the only source.
  if (args.cityPath !== undefined) {
    return JSON.parse(readFileSync(args.cityPath, 'utf8')) as CityJson;
  }
  if (args.logPath === undefined) {
    throw new Error('--report needs --city, since there is no log to look beside');
  }
  const path = resolve(dirname(resolve(args.logPath)), 'city.json');
  return JSON.parse(readFileSync(path, 'utf8')) as CityJson;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.report !== undefined) {
    runReport(args);
    return;
  }

  const logPath = args.logPath;
  if (logPath === undefined) throw new Error('no log to run');
  const log = decodeInputLog(new Uint8Array(readFileSync(resolve(logPath))));
  const city = prepareCity(packCity(loadCity(args)));

  const options = args.hashInterval === undefined ? {} : { hashInterval: args.hashInterval };
  const result = runLog(log, city, options);

  if (args.quiet) {
    process.stdout.write(`${result.score} ${result.deliveries} ${result.hashTrail.at(-1)}\n`);
    return;
  }

  const lines = [
    `log        ${logPath}`,
    `seed       ${log.seed}`,
    `city       ${log.cityHash.toString(16).padStart(8, '0')}`,
    `ticks      ${result.ticks}`,
    `score      ${result.score}`,
    `deliveries ${result.deliveries}`,
    `final hash ${(result.hashTrail.at(-1) ?? 0).toString(16).padStart(8, '0')}`,
    `trail      ${result.hashTrail.length} samples every ${result.hashInterval} ticks`,
    result.hashTrail
      .slice(0, 8)
      .map((hash) => hash.toString(16).padStart(8, '0'))
      .join(' ') + (result.hashTrail.length > 8 ? ' …' : ''),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Measure a city instead of replaying a log — `W-04`'s verify line.
 *
 * Drives with the same bot the goldens are recorded from, because traffic and
 * demand are both properties of the *city* but a driven run exercises the
 * demand field the way a player does: fares get taken, passengers despawn, and
 * the field has to keep producing.
 */
function runReport(args: Args): void {
  const city = prepareCity(packCity(loadCity(args)));
  const world = createWorld(RUN_SEED, 1, city);

  // Start somewhere on the road. `G-01` will own this properly; until then a
  // cab left at the origin may be inside a building.
  const start = startNode(city);
  setCar(world, 0, Car.X, start.x);
  setCar(world, 0, Car.Y, start.y);

  const report = measureRun(world, city, Math.round(args.seconds * TICK_HZ), (w) =>
    botInput(w, city),
  );
  process.stdout.write(`${formatReport(report)}\n`);
}

/** The first junction in the city, as a place to put the cab. */
function startNode(city: RuntimeCity): { readonly x: number; readonly y: number } {
  const nodes = city.packed.nodes;
  if (nodes.length < 2) return { x: 0, y: 0 };
  return { x: nodes[0] as number, y: nodes[1] as number };
}

/** Fixed, so a report is reproducible. */
const RUN_SEED = 20260821;

try {
  main();
} catch (error) {
  process.stderr.write(`simrun: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
