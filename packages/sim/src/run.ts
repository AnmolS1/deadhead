/**
 * `run.ts` — replay an input log.
 *
 * One function, four consumers, and that is the whole point of building it
 * carefully:
 *
 * - **`B-08`**, the replay validator, re-runs a submitted log server-side and
 *   derives the score itself. A client submits inputs, never a number.
 * - **`S-14`**, the golden tests, replays recorded logs and compares hash
 *   trails. If one diverges, determinism broke and multiplayer and the
 *   leaderboard are both silently wrong.
 * - **`G-07`**, ghost racing, drives a translucent second cab from a stored
 *   log. That feature is *free* — the anti-cheat system already stores exactly
 *   the data a ghost needs.
 * - **`M-14`**, the load test, drives bot clients from plausible logs.
 *
 * ## The hash trail
 *
 * A single final hash tells you a replay diverged. A trail tells you *when*,
 * which is the difference between "determinism is broken somewhere" and a tick
 * number to bisect from. `B-08` logs the first mismatching interval, so a spike
 * in divergences can be told apart from a spike in cheating.
 */
import { decodeInputLog, type InputLog } from '@deadhead/proto';

import type { RuntimeCity } from './city.js';
import { getCar, hashWorld, createWorld, Car, type World } from './world.js';
import { step } from './step.js';

/** How often {@link runLog} records a hash, unless told otherwise. */
export const DEFAULT_HASH_INTERVAL = 100;

export interface RunOptions {
  /** Ticks between hash samples. Smaller narrows a divergence; larger is cheaper. */
  readonly hashInterval?: number;
  /**
   * Replay only the first `n` ticks. Used by `S-14` to bisect a divergence and
   * by `G-07` to scrub a ghost.
   */
  readonly maxTicks?: number;
}

export interface RunResult {
  /** State after the last tick. */
  readonly world: World;
  /** Money earned, in minor units — the score `G-04` formalises and `B-09` ranks. */
  readonly score: number;
  /** Completed fares. `G-01`'s tiebreak. */
  readonly deliveries: number;
  /** Ticks actually replayed. */
  readonly ticks: number;
  /** World hash sampled every {@link RunOptions.hashInterval} ticks, plus the final tick. */
  readonly hashTrail: readonly number[];
  /** Interval the trail was sampled at, so two trails can be compared meaningfully. */
  readonly hashInterval: number;
}

/**
 * Replay a log against a city and report what happened.
 *
 * Refuses a city the log was not played on. ADR 0005 already makes a wrong city
 * diverge — the content hash is folded into the run seed — but divergence is a
 * mystery and a hash mismatch is a sentence. `B-08` needs to tell "the client
 * lied" apart from "we changed the city".
 */
export function runLog(log: InputLog, city: RuntimeCity, options: RunOptions = {}): RunResult {
  if (log.cityHash !== city.packed.contentHash) {
    throw new RangeError(
      `log was played on city ${log.cityHash.toString(16)}, not ${city.packed.contentHash.toString(16)}`,
    );
  }

  const hashInterval = options.hashInterval ?? DEFAULT_HASH_INTERVAL;
  if (hashInterval <= 0) throw new RangeError('hashInterval must be positive');

  const ticks = Math.min(log.ticks.length, options.maxTicks ?? log.ticks.length);

  let world = createWorld(log.seed, 1, city);
  const hashTrail: number[] = [hashWorld(world)];
  const inputs = [0];

  for (let tick = 0; tick < ticks; tick += 1) {
    inputs[0] = log.ticks[tick] as number;
    world = step(world, inputs);
    if ((tick + 1) % hashInterval === 0) hashTrail.push(hashWorld(world));
  }

  // Always finish with the final state, even when it is not on an interval, so
  // two runs of different lengths cannot accidentally compare equal.
  if (ticks % hashInterval !== 0) hashTrail.push(hashWorld(world));

  return {
    world,
    score: getCar(world, 0, Car.Cash),
    deliveries: getCar(world, 0, Car.Deliveries),
    ticks,
    hashTrail,
    hashInterval,
  };
}

/** Convenience for a log still in its encoded form. */
export function runEncodedLog(
  bytes: Uint8Array,
  city: RuntimeCity,
  options: RunOptions = {},
): RunResult {
  return runLog(decodeInputLog(bytes), city, options);
}

/**
 * The first tick interval at which two hash trails disagree, or -1 if they
 * match.
 *
 * Returns a *tick*, not an index, because the number a human wants is "replay
 * to here and look". `B-08` records it so a determinism regression can be told
 * apart from a wave of cheating: cheating clusters on one account, a regression
 * clusters on one tick.
 */
export function firstDivergence(
  a: readonly number[],
  b: readonly number[],
  hashInterval: number,
): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return i * hashInterval;
  }
  return a.length === b.length ? -1 : shared * hashInterval;
}
