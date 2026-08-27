/**
 * `debug/tuning.ts` — the car-tuning round-trip.
 *
 * `C-06`'s done-when is *"the car-tuning sliders round-trip to JSON"*. This is
 * that round-trip, and it has two constraints that pull against each other.
 *
 * ## 1. The round-trip must be exact, or it breaks the goldens
 *
 * `CarTuning`'s values are authored per second and stored **per tick, in 16.16
 * fixed point** — `fxFromRatio(48, 30 * 30)` reads as "48 units/s² at 30 Hz"
 * and is stored as `round(48 × 65536 / 900) = 3495`. Decoding that back gives
 * `47.9965…`, not 48, so the readable number is visibly not the stored one.
 *
 * The stakes are real: if a constant drifts by a single fixed-point unit the
 * sim changes, every golden replay in `packages/sim/test/golden/` fails, and
 * multiplayer and the leaderboard are both silently wrong (ADR 0004).
 *
 * At **full float precision** the display round-trip happens to be exact:
 * `toDisplay` multiplies by the tick scale and `fromDisplay` divides by the
 * same scale, so the two cancel and `round` recovers the original integer —
 * measured across ±200,000 raw units at every scale in use, maximum error zero.
 *
 * **It stops being exact the moment the display value is rounded, and how soon
 * depends on the constant.** One fixed-point unit is `scale / 65536` in display
 * terms, so the tick-scaled constants have coarse resolution and survive
 * anything, while the scale-1 fractions resolve to 0.0000153 and need many
 * digits. Measured, minimum decimal places to recover the stored integer:
 *
 * | constant       | scale | 1 fx unit  | dp needed |
 * |----------------|-------|------------|-----------|
 * | `acceleration` |   900 | 0.0137     | 0         |
 * | `maxSpeed`     |    30 | 0.00046    | 0         |
 * | `halfLength`   |     1 | 0.0000153  | 1         |
 * | `lateralSlide` |     1 | 0.0000153  | 2         |
 * | **`drag`**     |     1 | 0.0000153  | **5**     |
 *
 * So `raw` is **load-bearing, not decoration**. Present `drag` to two decimal
 * places — an entirely reasonable thing for a slider to do — and it comes back
 * as 64881 instead of 65142. That is a different car, a different sim, and
 * every golden replay in the repo red.
 *
 * (This comment has been wrong in both directions. It first asserted the
 * round-trip was lossy without checking; the correction over-corrected to "not
 * lossy at all" on a two-decimal-place spot check that happened to use a
 * tick-scaled constant. The table above is measured across the whole table.
 * Both errors were the same one: describing arithmetic instead of running it.)
 *
 * ## 2. The sliders cannot be live, and that is not a bug
 *
 * `CarTuning` is `as const`, deliberately: the per-second → per-tick conversion
 * happens once at module load, never at runtime, because a runtime conversion
 * would be the fixed-point `dt` this project does not have. Mutating it
 * mid-run would also make the run unreplayable — the validator loads the
 * tuning compiled into the Worker, not whatever the client had in memory.
 *
 * So the flow is **slider → JSON → paste into `car.ts` → reload**. The brief
 * says "writing to a copy-pasteable JSON blob", and that phrasing is load-
 * bearing rather than incidental. See the note on `C-06` in `TASKS.md`.
 */
import { CarTuning, FX_ONE, TICK_HZ } from '@deadhead/sim';

/** The tuning keys, so the panel and the round-trip cannot drift apart. */
export const TUNING_KEYS = Object.keys(CarTuning) as (keyof typeof CarTuning)[];

export type TuningKey = (typeof TUNING_KEYS)[number];

/** A tuning table as the debug panel holds it: raw 16.16 per-tick values. */
export type TuningDraft = Record<TuningKey, number>;

/**
 * How a value converts between storage and the slider's units.
 *
 * Not every constant is a rate. `drag` and `lateralSlide` are per-tick
 * *multipliers* — a fraction retained each tick — and multiplying one by 30 to
 * "convert to per second" produces a meaningless number. Getting this wrong
 * would put a slider labelled "29.8 units/s" on a value whose sensible range is
 * 0 to 1.
 */
export const enum Unit {
  /** A rate: stored per tick, shown per second. */
  PerSecond,
  /** A rate of change of a rate: stored per tick², shown per second². */
  PerSecondSquared,
  /** A per-tick multiplier in `[0, 1]`. Shown as-is. */
  Fraction,
  /** An absolute quantity with no time component. Shown as-is. */
  Scalar,
}

/**
 * Which unit each constant is in.
 *
 * Stated explicitly rather than guessed from the name, because the names do not
 * distinguish them: `steerRate` is degrees per second, `lateralSlide` is a
 * dimensionless fraction, and both end in something that reads like a rate.
 */
export const TUNING_UNITS: Record<TuningKey, Unit> = {
  acceleration: Unit.PerSecondSquared,
  braking: Unit.PerSecondSquared,
  reverse: Unit.PerSecondSquared,
  drag: Unit.Fraction,
  lateralSlide: Unit.Fraction,
  handbrakeSlide: Unit.Fraction,
  /** A multiplier on `steerRate`, so dimensionless — not a rate itself. */
  handbrakeYaw: Unit.Scalar,
  steerRate: Unit.Scalar,
  steerFalloffSpeed: Unit.PerSecond,
  maxSpeed: Unit.PerSecond,
  maxReverseSpeed: Unit.PerSecond,
  restSpeed: Unit.PerSecond,
  /** Half-extents are lengths in world units — no time component at all. */
  halfLength: Unit.Scalar,
  halfWidth: Unit.Scalar,
  /** Speed lost in one impact, so a rate like any other. */
  crashImpact: Unit.PerSecond,
};

/** The multiplier taking a stored value to its displayed one. */
function displayScale(unit: Unit): number {
  switch (unit) {
    case Unit.PerSecond:
      return TICK_HZ;
    case Unit.PerSecondSquared:
      return TICK_HZ * TICK_HZ;
    case Unit.Fraction:
    case Unit.Scalar:
      return 1;
  }
}

/** One row of the panel: what to show, and what it is really worth. */
export interface TuningRow {
  readonly key: TuningKey;
  /** Raw 16.16 per-tick value — the source of truth. */
  readonly raw: number;
  /** Human-readable value in this constant's natural units. */
  readonly display: number;
  readonly unit: Unit;
}

/** Convert a stored value to what the slider should show. */
export function toDisplay(key: TuningKey, raw: number): number {
  return (raw / FX_ONE) * displayScale(TUNING_UNITS[key]);
}

/** Convert a slider's value back to storage. Rounds, because storage is integral. */
export function fromDisplay(key: TuningKey, display: number): number {
  return Math.round((display / displayScale(TUNING_UNITS[key])) * FX_ONE) | 0;
}

/** The tuning the sim is actually compiled with. */
export function currentTuning(): TuningDraft {
  const draft = {} as TuningDraft;
  for (const key of TUNING_KEYS) draft[key] = CarTuning[key];
  return draft;
}

/** Every row, for rendering the panel. */
export function rows(draft: TuningDraft): TuningRow[] {
  return TUNING_KEYS.map((key) => ({
    key,
    raw: draft[key],
    display: toDisplay(key, draft[key]),
    unit: TUNING_UNITS[key],
  }));
}

/** The JSON shape. Raw is authoritative; display is for humans. */
export interface TuningJson {
  readonly version: 1;
  readonly tickHz: number;
  readonly values: Record<string, { readonly raw: number; readonly display: number }>;
}

/**
 * Serialise a draft to the blob the panel copies out.
 *
 * Both numbers are written: `raw` so the round-trip is exact, `display` so a
 * human editing the blob by hand has something meaningful to edit.
 */
export function toJson(draft: TuningDraft): TuningJson {
  const values: Record<string, { raw: number; display: number }> = {};
  for (const key of TUNING_KEYS) {
    values[key] = { raw: draft[key], display: toDisplay(key, draft[key]) };
  }
  return { version: 1, tickHz: TICK_HZ, values };
}

export class TuningParseError extends Error {}

/**
 * Read a draft back out of a blob.
 *
 * **`raw` wins unless `display` has been edited.** At full precision `display`
 * would reproduce `raw`, but any rounding breaks that for the scale-1 constants
 * — `drag` needs five decimal places (see the module comment) — so trusting
 * `display` would silently change the car the moment the blob passed through
 * anything that formatted a number.
 *
 * The other half of the rule: a `display` disagreeing with its `raw` by more
 * than one fixed-point unit can only be a deliberate hand edit, so editing the
 * readable number still works. It could not if `raw` always won.
 */
export function fromJson(json: unknown): TuningDraft {
  if (typeof json !== 'object' || json === null) {
    throw new TuningParseError('tuning must be an object');
  }
  const blob = json as Partial<TuningJson>;
  if (blob.version !== 1) {
    throw new TuningParseError(`unsupported tuning version: ${String(blob.version)}`);
  }
  if (blob.tickHz !== TICK_HZ) {
    // Every stored value is per tick. Loading a 60 Hz blob into a 30 Hz sim
    // would halve every rate silently.
    throw new TuningParseError(
      `tuning was authored at ${String(blob.tickHz)} Hz but this sim runs at ${TICK_HZ} Hz`,
    );
  }
  if (typeof blob.values !== 'object' || blob.values === null) {
    throw new TuningParseError('tuning has no values');
  }

  const draft = {} as TuningDraft;
  for (const key of TUNING_KEYS) {
    const entry = blob.values[key];
    if (entry === undefined) {
      throw new TuningParseError(`tuning is missing ${key}`);
    }
    if (!Number.isFinite(entry.raw) || !Number.isInteger(entry.raw)) {
      throw new TuningParseError(`${key}.raw must be an integer, got ${String(entry.raw)}`);
    }

    // Did a human edit the readable number? Compare against what `raw` decodes
    // to, with a tolerance covering one unit of fixed-point rounding.
    const decoded = toDisplay(key, entry.raw);
    const tolerance = Math.abs(toDisplay(key, 1)) * 1.5;
    const edited = Number.isFinite(entry.display) && Math.abs(entry.display - decoded) > tolerance;

    draft[key] = edited ? fromDisplay(key, entry.display) : entry.raw;
  }
  return draft;
}

/**
 * A `car.ts`-shaped snippet, for pasting back into the sim.
 *
 * Emitted as raw integers with the human value in a trailing comment rather
 * than as `fxFromRatio(...)` calls: the draft's exact integers are what was
 * being played, and re-deriving them from a ratio could land one unit away.
 */
export function toSourceSnippet(draft: TuningDraft): string {
  const lines = TUNING_KEYS.map((key) => {
    const display = toDisplay(key, draft[key]);
    const rounded = Math.abs(display) < 100 ? display.toFixed(4) : display.toFixed(2);
    return `  ${key}: ${draft[key]},${' '.repeat(Math.max(1, 24 - key.length - String(draft[key]).length))}// ${rounded}${unitSuffix(TUNING_UNITS[key])}`;
  });
  return `export const CarTuning = {\n${lines.join('\n')}\n} as const;`;
}

function unitSuffix(unit: Unit): string {
  switch (unit) {
    case Unit.PerSecond:
      return ' units/s';
    case Unit.PerSecondSquared:
      return ' units/s²';
    case Unit.Fraction:
      return ' per tick';
    case Unit.Scalar:
      return '';
  }
}

/** Whether a draft differs from what the sim is compiled with. */
export function isModified(draft: TuningDraft): boolean {
  return TUNING_KEYS.some((key) => draft[key] !== CarTuning[key]);
}
