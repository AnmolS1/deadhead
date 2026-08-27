/**
 * `debug/playtest-tuning.ts` — tuning dials on the URL, for a playtest.
 *
 * Anmol's second playtest produced three tuning notes and one instruction:
 * *"or let me test a few options so we can really tune it well."* This is that.
 * The numbers below are **not** decided here — they are made adjustable so the
 * person driving can decide them.
 *
 * ## ⚠️ This is scaffolding and it has to come out
 *
 * `B-07` re-simulates a submitted input log **server-side** to derive the score.
 * A client that can silently change its own physics is therefore a leaderboard
 * hole: play at `?speed=2`, submit the log, and the server replays it under the
 * real constants and gets a different — possibly better — answer. Right now
 * nothing submits anything, so this is safe; the moment `B-07` wires up, it is
 * not. **There is a note under `B-07` in `TASKS.md`**, because a comment here
 * is not where the person building submission will look.
 *
 * ## Why mutating the tuning objects is acceptable here and nowhere else
 *
 * `CarTuning` and `FareTuning` are `as const`, which is a **type-level**
 * assertion — the objects are not frozen and are writable at runtime (checked,
 * not assumed). Overrides are applied **once, before any world is created**, so
 * within a session the sim still sees constants and every guarantee it makes
 * about determinism holds. What breaks is comparability *between* sessions with
 * different parameters, which is exactly what a tuning experiment is for.
 *
 * ## An altered build must say so
 *
 * {@link tuningBanner} returns a line for the renderer to draw. A tester playing
 * a modified build without knowing it is worse than no test at all — and worse
 * still is a tester the *operator* forgot to reset. The banner is what makes a
 * session's results attributable to a set of numbers.
 */
import { CarTuning, FareTuning, fxFromRatio } from '@deadhead/sim';

/** Constants a playtest may move, and how each is expressed on the URL. */
interface Dial {
  readonly param: string;
  readonly label: string;
  /**
   * Smallest accepted value.
   *
   * **Not decoration.** `Number('')` is `0`, which is finite and non-negative,
   * so an empty `?speed=` sailed through the first version of the guard and set
   * `maxSpeed` to zero — a car that cannot move, with the banner cheerfully
   * reporting "speed 0.00x". A malformed URL handed to a tester must cost that
   * dial, not the session. Only `fare` accepts 0, where it means "uncapped".
   */
  readonly min: number;
  /** Applies the value. Returns how it should read in the banner. */
  readonly apply: (value: number) => string;
}

/** A writable view of the tuning tables. See the note above on why this is OK. */
const car = CarTuning as unknown as Record<string, number>;
const fare = FareTuning as unknown as Record<string, number>;

/**
 * The stock values, captured at module load before anything can move them.
 *
 * **Multipliers must apply to the shipped constant, not the current one.**
 * Reading the live value would make `apply` compound on a second call — so
 * calling it twice with `?speed=1.2` would silently give 1.44x, and the banner
 * would confidently report 1.20x. That is a measurement lying about itself,
 * which is the one thing a tuning harness must never do.
 */
const STOCK = {
  maxSpeed: CarTuning.maxSpeed,
  steerRate: CarTuning.steerRate,
} as const;

const DIALS: readonly Dial[] = [
  {
    // Note 2: "the car still moves pretty slowly for a city of that size."
    // A MULTIPLIER rather than an absolute, so it reads as "how much faster".
    param: 'speed',
    min: Number.EPSILON,
    label: 'speed',
    apply: (multiplier) => {
      car.maxSpeed = Math.round(STOCK.maxSpeed * multiplier);
      return `${multiplier.toFixed(2)}x (${(30 * multiplier) | 0} u/s)`;
    },
  },
  {
    // **The one that is easy to forget, and the reason speed alone is a trap.**
    // Turn radius is speed / turn-rate, so raising speed without raising steer
    // widens every corner: at 50 u/s the radius returns to ~43 units against a
    // 25-unit block, which is the exact problem ADR 0008 just fixed. Any speed
    // test worth running pairs these two.
    param: 'steer',
    min: Number.EPSILON,
    label: 'steer',
    apply: (multiplier) => {
      car.steerRate = Math.round(STOCK.steerRate * multiplier);
      return `${multiplier.toFixed(2)}x`;
    },
  },
  {
    // Note 1, first half: "the pickup radius is too small... consider raising
    // it ~10px". At 8 CSS px per world unit, 10px is about 1.25 units, so the
    // default 3 becomes roughly 4.25. Absolute units, not a multiplier, because
    // the note was in absolute terms.
    param: 'pickup',
    min: Number.EPSILON,
    label: 'pickup r',
    apply: (units) => {
      fare.pickupRadius = fxFromRatio(Math.round(units * 100), 100);
      return `${units.toFixed(2)} u`;
    },
  },
  {
    // Note 1, SECOND half — and the part the note did not know about.
    // `resolvePickups` refuses unless `carSpeed <= stoppedSpeed` (4 u/s), so the
    // difficulty is not a 3-unit circle: it is decelerating to a near-stop
    // inside one. Raising this may help more than the radius, and it trades
    // differently — a bigger circle forgives aim, a higher threshold allows a
    // slow-roll pickup. Both are on the dial so the playtest can tell them apart.
    param: 'stop',
    min: Number.EPSILON,
    label: 'pickup speed',
    apply: (unitsPerSecond) => {
      fare.stoppedSpeed = fxFromRatio(Math.round(unitsPerSecond * 100), 30 * 100);
      return `${unitsPerSecond.toFixed(1)} u/s`;
    },
  },
  {
    // Note 3, in whole world units. See `FareTuning.maxFareUnits` for why a
    // hard 15-second cap (~346 units) is the wrong shape: it discards 77% of
    // City 01's destination pairs and leaves a median of 4 per spawn.
    param: 'fare',
    min: 0,
    label: 'max fare',
    apply: (units) => {
      fare.maxFareUnits = Math.round(units);
      return `${Math.round(units)} u (~${(units / 30).toFixed(0)}s)`;
    },
  },
];

let banner: string | null = null;

/**
 * Read the URL and apply any overrides. Call **once**, before `createWorld`.
 *
 * Ignores anything unparseable rather than throwing: a typo in a URL handed to
 * a playtester should cost that dial, not the session.
 */
export function applyPlaytestTuning(search: string): void {
  const params = new URLSearchParams(search);
  const applied: string[] = [];

  for (const dial of DIALS) {
    const raw = params.get(dial.param);
    if (raw === null || raw.trim() === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < dial.min) continue;
    applied.push(`${dial.label} ${dial.apply(value)}`);
  }

  banner = applied.length > 0 ? `TUNING · ${applied.join(' · ')}` : null;
}

/** The banner line, or `null` when the build is stock. */
export function tuningBanner(): string | null {
  return banner;
}
