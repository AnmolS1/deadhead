import { ClockTuning } from '@deadhead/sim';
import { describe, expect, it } from 'vitest';

import {
  AudioTuning,
  bankFraction,
  clockHz,
  clockPeriodSeconds,
  engineHz,
  loadMuted,
  mixFor,
  saveMuted,
  type AudioState,
} from '../src/audio/index.js';

/**
 * `C-07`. These test `policy.ts` — the half with decisions in it. `engine.ts`
 * is Web Audio wiring and cannot be tested here at all: neither node nor
 * `workerd` has an `AudioContext`, which is exactly why the numbers live in a
 * separate module.
 */

const EMPTY: AudioState = {
  carrying: false,
  deadheadTicks: ClockTuning.startingDeadheadTicks,
  speedPerTick: 0,
  eliminated: false,
};

const CARRYING: AudioState = { ...EMPTY, carrying: true };

describe('bankFraction', () => {
  it('is 1 at the start of a run and 0 at the end', () => {
    expect(bankFraction(ClockTuning.startingDeadheadTicks)).toBe(1);
    expect(bankFraction(0)).toBe(0);
  });

  it('is derived from ClockTuning, not from a restated 180 seconds', () => {
    // The point of this test. `DESIGN.md` §7 flags the starting bank as
    // "inherited, not designed" and expects it to move; if it does and this
    // still passes, the audio followed it. A hardcoded 5400 would not.
    expect(bankFraction(ClockTuning.startingDeadheadTicks / 2)).toBeCloseTo(0.5, 6);
  });

  it('clamps rather than going out of range', () => {
    expect(bankFraction(-100)).toBe(0);
    expect(bankFraction(ClockTuning.startingDeadheadTicks * 3)).toBe(1);
    expect(bankFraction(Number.NaN)).toBe(0);
  });
});

describe('engineHz', () => {
  it('idles at a standstill', () => {
    expect(engineHz(0)).toBe(AudioTuning.engineIdleHz);
  });

  it('reaches its top note at the top speed and holds there', () => {
    expect(engineHz(AudioTuning.engineTopSpeed)).toBeCloseTo(AudioTuning.engineMaxHz, 6);
    // Both sides of the boundary. A one-sided test cannot detect a pitch that
    // keeps climbing — which would slide the engine into a whistle on a long
    // straight and sound like a bug.
    expect(engineHz(AudioTuning.engineTopSpeed * 5)).toBeCloseTo(AudioTuning.engineMaxHz, 6);
  });

  it('rises monotonically with speed', () => {
    let previous = -Infinity;
    for (let s = 0; s <= AudioTuning.engineTopSpeed; s += AudioTuning.engineTopSpeed / 20) {
      const hz = engineHz(s);
      expect(hz).toBeGreaterThanOrEqual(previous);
      previous = hz;
    }
  });

  it('treats reverse as speed, not as negative pitch', () => {
    expect(engineHz(-0.3)).toBe(engineHz(0.3));
  });
});

describe('clockHz', () => {
  it('is slowest on a full bank and fastest on an empty one', () => {
    expect(clockHz(1)).toBeCloseTo(AudioTuning.clockSlowHz, 6);
    expect(clockHz(0)).toBeCloseTo(AudioTuning.clockFastHz, 6);
  });

  it('accelerates — it does not merely increase', () => {
    // The curve is squared in the remaining fraction so most of the
    // acceleration lands in the last third. A linear ramp is nearly flat where
    // it matters and the ending arrives with no warning.
    const early = clockHz(1.0) - clockHz(0.8);
    const late = clockHz(0.2) - clockHz(0.0);
    expect(Math.abs(late)).toBeGreaterThan(Math.abs(early) * 2);
  });

  it('never exceeds the fast bound, which is the legibility ceiling', () => {
    for (let b = 0; b <= 1; b += 0.05) {
      expect(clockHz(b)).toBeLessThanOrEqual(AudioTuning.clockFastHz + 1e-9);
      expect(clockHz(b)).toBeGreaterThanOrEqual(AudioTuning.clockSlowHz - 1e-9);
    }
  });
});

describe('mixFor — the mechanic', () => {
  it('silences the clock while carrying', () => {
    // THE assertion of C-08. The pass condition is a player saying "the timer
    // stops when someone's in the car" — they can only say it if something
    // audibly stops. A clock that merely slowed would say "this still matters"
    // while meaning the opposite.
    expect(mixFor(CARRYING).clock).toBe(0);
    expect(mixFor(CARRYING).clockHz).toBe(0);
  });

  it('runs the clock while empty', () => {
    expect(mixFor(EMPTY).clock).toBeGreaterThan(0);
    expect(mixFor(EMPTY).clockHz).toBeGreaterThan(0);
  });

  it('thins the music when empty but never silences it', () => {
    const empty = mixFor(EMPTY).music;
    const carrying = mixFor(CARRYING).music;
    expect(empty).toBeLessThan(carrying);
    // Not zero, deliberately: silence reads as the audio breaking, a thin
    // thread reads as something running out.
    expect(empty).toBeGreaterThan(0);
  });

  it('keeps the engine running in both states — the cab does not stop', () => {
    expect(mixFor(EMPTY).engine).toBe(mixFor(CARRYING).engine);
    expect(mixFor(EMPTY).engine).toBeGreaterThan(0);
  });

  it('goes fully silent for an eliminated cab', () => {
    // `scene.ts` stops DRAWING an eliminated cab. An engine still running under
    // a car that is no longer on screen is the audio version of that bug.
    const dead = mixFor({ ...EMPTY, eliminated: true });
    expect(dead.music).toBe(0);
    expect(dead.engine).toBe(0);
    expect(dead.clock).toBe(0);
  });

  it('speeds the clock as the bank drains, while empty', () => {
    const full = mixFor(EMPTY).clockHz;
    const nearlyGone = mixFor({
      ...EMPTY,
      deadheadTicks: ClockTuning.startingDeadheadTicks / 20,
    }).clockHz;
    expect(nearlyGone).toBeGreaterThan(full);
  });
});

describe('clockPeriodSeconds', () => {
  it('is infinite when the clock is silent, so a scheduler emits nothing', () => {
    expect(clockPeriodSeconds(mixFor(CARRYING))).toBe(Infinity);
  });

  it('is the reciprocal of the rate otherwise', () => {
    const mix = mixFor(EMPTY);
    expect(clockPeriodSeconds(mix)).toBeCloseTo(1 / mix.clockHz, 9);
  });
});

describe('mute persistence', () => {
  function fakeStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      get length() {
        return map.size;
      },
    } as Storage;
  }

  it('defaults to unmuted', () => {
    expect(loadMuted(fakeStorage())).toBe(false);
    expect(loadMuted(null)).toBe(false);
  });

  it('round-trips', () => {
    const storage = fakeStorage();
    saveMuted(storage, true);
    expect(loadMuted(storage)).toBe(true);
    saveMuted(storage, false);
    expect(loadMuted(storage)).toBe(false);
  });

  it('survives a storage that throws, rather than taking the game down', () => {
    // `localStorage` THROWS on access in some privacy modes rather than
    // returning null. `input/bindings.ts` handles it the same way; a muted
    // preference is not worth an exception that stops the page.
    const hostile = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;

    expect(loadMuted(hostile)).toBe(false);
    expect(() => saveMuted(hostile, true)).not.toThrow();
  });
});
