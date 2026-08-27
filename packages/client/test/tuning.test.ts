import { describe, expect, it } from 'vitest';

import { FX_ONE, CarTuning, TICK_HZ } from '@deadhead/sim';

import {
  TUNING_KEYS,
  TUNING_UNITS,
  TuningParseError,
  Unit,
  currentTuning,
  fromDisplay,
  fromJson,
  isModified,
  rows,
  toDisplay,
  toJson,
  toSourceSnippet,
} from '../src/debug/tuning.js';

describe('the round-trip is exact', () => {
  it('returns every constant unchanged, bit for bit', () => {
    // C-06's done-when. And more than a formality: CarTuning drifting by one
    // fixed-point unit changes the sim, which fails every golden replay in
    // packages/sim/test/golden/ and makes multiplayer and the leaderboard both
    // silently wrong (ADR 0004).
    const before = currentTuning();
    const after = fromJson(JSON.parse(JSON.stringify(toJson(before))));

    for (const key of TUNING_KEYS) {
      expect(after[key], key).toBe(before[key]);
    }
  });

  it('survives many cycles without drifting', () => {
    // Twenty export-and-paste cycles. Any per-pass error at all compounds here.
    let draft = currentTuning();
    for (let cycle = 0; cycle < 20; cycle += 1) {
      draft = fromJson(JSON.parse(JSON.stringify(toJson(draft))));
    }
    for (const key of TUNING_KEYS) {
      expect(draft[key], key).toBe(CarTuning[key]);
    }
  });

  it('is exact through display at full float precision', () => {
    // The scales cancel, so round() recovers the original integer. True for
    // every constant — but only while nothing rounds the number.
    for (const key of TUNING_KEYS) {
      expect(fromDisplay(key, toDisplay(key, CarTuning[key])), key).toBe(CarTuning[key]);
    }
  });

  it('is NOT exact once display is rounded, which is why raw is stored', () => {
    // The measurement that settles it. One fixed-point unit is scale/65536 in
    // display terms, so the scale-1 fractions resolve to 0.0000153 and two
    // decimal places is 300x too coarse. `drag` comes back as 64881 instead of
    // 65142 — a different car, a different sim, every golden replay red.
    //
    // A slider showing two decimals is an entirely reasonable thing to build.
    // That is exactly why the JSON does not trust the readable number.
    const survived: string[] = [];
    const lost: string[] = [];
    for (const key of TUNING_KEYS) {
      const shown = Number(toDisplay(key, CarTuning[key]).toFixed(2));
      (fromDisplay(key, shown) === CarTuning[key] ? survived : lost).push(key);
    }

    expect(lost).toContain('drag');
    expect(survived).toContain('acceleration');

    // And the whole point: the real round-trip is unaffected by any of this,
    // because it carries raw.
    const draft = fromJson(JSON.parse(JSON.stringify(toJson(currentTuning()))));
    expect(draft.drag).toBe(CarTuning.drag);
  });
});

describe('a hand edit wins', () => {
  it('honours a display value a human changed', () => {
    // The other half. If `raw` always won, editing the readable number in the
    // blob would do nothing at all — silently.
    const json = toJson(currentTuning());
    const edited = {
      ...json,
      values: { ...json.values, maxSpeed: { ...json.values.maxSpeed!, display: 40 } },
    };

    const draft = fromJson(JSON.parse(JSON.stringify(edited)));
    expect(toDisplay('maxSpeed', draft.maxSpeed)).toBeCloseTo(40, 3);
    expect(draft.maxSpeed).not.toBe(CarTuning.maxSpeed);
  });

  it('ignores a display that differs only by encoding error', () => {
    // 47.9967 vs 48 is the round-trip's own rounding, not a human decision.
    const json = toJson(currentTuning());
    const nudged = {
      ...json,
      values: {
        ...json.values,
        acceleration: { ...json.values.acceleration!, display: 48 },
      },
    };

    const draft = fromJson(JSON.parse(JSON.stringify(nudged)));
    expect(draft.acceleration).toBe(CarTuning.acceleration);
  });

  it('leaves the other constants alone when one is edited', () => {
    const json = toJson(currentTuning());
    const edited = {
      ...json,
      values: { ...json.values, braking: { ...json.values.braking!, display: 200 } },
    };

    const draft = fromJson(JSON.parse(JSON.stringify(edited)));
    for (const key of TUNING_KEYS) {
      if (key === 'braking') continue;
      expect(draft[key], key).toBe(CarTuning[key]);
    }
  });
});

describe('units', () => {
  it('covers every constant, so none is silently mislabelled', () => {
    for (const key of TUNING_KEYS) {
      expect(TUNING_UNITS[key], key).toBeDefined();
    }
  });

  it('does not treat a per-tick fraction as a rate', () => {
    // drag is a multiplier retained each tick, not a speed. Multiplying it by
    // 30 to "convert to per second" would put a slider reading 29.8 on a value
    // whose sensible range is 0 to 1 — and the name gives no clue either way,
    // which is why the table is explicit rather than inferred.
    expect(TUNING_UNITS.drag).toBe(Unit.Fraction);
    expect(toDisplay('drag', CarTuning.drag)).toBeCloseTo(0.994, 3);
    expect(toDisplay('drag', CarTuning.drag)).toBeLessThan(1);
  });

  it('converts a per-second rate through the tick rate', () => {
    // Asserts the CONVERSION, not a particular speed. The old version pinned
    // this to TICK_HZ because maxSpeed happened to be 30 units/s — so a routine
    // tuning change broke a test about unit conversion, which is a test
    // measuring the wrong thing. `maxSpeed` is stored per tick, so its display
    // value is that times the tick rate, whatever the tuning says today.
    const perTick = CarTuning.maxSpeed / FX_ONE;
    expect(toDisplay('maxSpeed', CarTuning.maxSpeed)).toBeCloseTo(perTick * TICK_HZ, 2);
  });

  it('converts an acceleration through the tick rate squared', () => {
    expect(toDisplay('acceleration', CarTuning.acceleration)).toBeCloseTo(48, 1);
    expect(toDisplay('braking', CarTuning.braking)).toBeCloseTo(96, 1);
  });

  it('round-trips a display edit through the same scale it was shown in', () => {
    for (const key of TUNING_KEYS) {
      const shown = toDisplay(key, CarTuning[key]);
      const back = toDisplay(key, fromDisplay(key, shown));
      expect(back, key).toBeCloseTo(shown, 2);
    }
  });
});

describe('rejecting bad input', () => {
  it('refuses a blob from a different tick rate', () => {
    // Every stored value is per tick. A 60 Hz blob loaded into a 30 Hz sim
    // would halve every rate, silently, and feel like a physics bug.
    const json = { ...toJson(currentTuning()), tickHz: 60 };
    expect(() => fromJson(json)).toThrow(TuningParseError);
    expect(() => fromJson(json)).toThrow(/60 Hz/);
  });

  it('refuses an unknown version', () => {
    expect(() => fromJson({ ...toJson(currentTuning()), version: 2 })).toThrow(TuningParseError);
  });

  it('refuses a missing constant rather than defaulting it to zero', () => {
    const json = toJson(currentTuning());
    const values = { ...json.values };
    delete values.maxSpeed;
    expect(() => fromJson({ ...json, values })).toThrow(/maxSpeed/);
  });

  it('refuses a non-integer raw', () => {
    const json = toJson(currentTuning());
    const broken = {
      ...json,
      values: { ...json.values, drag: { raw: 1.5, display: 0.9 } },
    };
    expect(() => fromJson(broken)).toThrow(/integer/);
  });

  it('refuses junk', () => {
    expect(() => fromJson(null)).toThrow(TuningParseError);
    expect(() => fromJson('nope')).toThrow(TuningParseError);
    expect(() => fromJson({ version: 1, tickHz: TICK_HZ })).toThrow(TuningParseError);
  });
});

describe('the panel view', () => {
  it('produces one row per constant', () => {
    const list = rows(currentTuning());
    expect(list).toHaveLength(TUNING_KEYS.length);
    expect(list.every((row) => Number.isFinite(row.display))).toBe(true);
  });

  it('knows when a draft has been changed', () => {
    const draft = currentTuning();
    expect(isModified(draft)).toBe(false);
    draft.maxSpeed += 1;
    expect(isModified(draft)).toBe(true);
  });
});

describe('the paste-back snippet', () => {
  it('emits raw integers, not re-derived ratios', () => {
    // The exact integers are what was being played. Re-deriving them from a
    // ratio could land one fixed-point unit away, which is a different sim.
    const snippet = toSourceSnippet(currentTuning());
    expect(snippet).toContain('export const CarTuning');
    expect(snippet).toContain('as const');
    for (const key of TUNING_KEYS) {
      expect(snippet, key).toContain(`${key}: ${CarTuning[key]},`);
    }
  });

  it('annotates each line with its human value and unit', () => {
    const snippet = toSourceSnippet(currentTuning());
    expect(snippet).toMatch(/units\/s²/);
    expect(snippet).toMatch(/per tick/);
  });
});
