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
import { prepareCity, runLog } from '@deadhead/sim';

interface Args {
  readonly logPath: string;
  readonly cityPath: string | undefined;
  readonly hashInterval: number | undefined;
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let logPath: string | undefined;
  let cityPath: string | undefined;
  let hashInterval: number | undefined;
  let quiet = false;

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
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      logPath = arg;
    }
  }

  if (logPath === undefined) {
    throw new Error('usage: simrun [--city city.json] [--interval N] [--quiet] <log>');
  }
  return { logPath, cityPath, hashInterval, quiet };
}

/**
 * Find the city for a log.
 *
 * `--city` wins. Otherwise look for `city.json` beside the log, which is the
 * convention the golden fixtures use — a log and the city it was played on are
 * only meaningful together.
 */
function loadCity(args: Args): CityJson {
  const path = args.cityPath ?? resolve(dirname(resolve(args.logPath)), 'city.json');
  return JSON.parse(readFileSync(path, 'utf8')) as CityJson;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const log = decodeInputLog(new Uint8Array(readFileSync(resolve(args.logPath))));
  const city = prepareCity(packCity(loadCity(args)));

  const options = args.hashInterval === undefined ? {} : { hashInterval: args.hashInterval };
  const result = runLog(log, city, options);

  if (args.quiet) {
    process.stdout.write(`${result.score} ${result.deliveries} ${result.hashTrail.at(-1)}\n`);
    return;
  }

  const lines = [
    `log        ${args.logPath}`,
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

try {
  main();
} catch (error) {
  process.stderr.write(`simrun: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
