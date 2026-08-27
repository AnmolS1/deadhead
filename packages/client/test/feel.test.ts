import { ClockTuning, TICK_HZ } from '@deadhead/sim';
import { describe, expect, it } from 'vitest';

import {
  FeelTuning,
  ease,
  elapsedEmptyTicks,
  feelFor,
  foldInsets,
  foldProgress,
  foldStartTick,
  foldedAreaFraction,
  type FeelState,
} from '../src/feel/policy.js';

/** A full bank, empty cab, run in progress. */
const START: FeelState = {
  carrying: false,
  deadheadTicks: ClockTuning.startingDeadheadTicks,
  eliminated: false,
};

/** `n` seconds of empty-cab time into the run. */
function afterSeconds(n: number): FeelState {
  return { ...START, deadheadTicks: ClockTuning.startingDeadheadTicks - n * TICK_HZ };
}

describe('the fold is the clock', () => {
  it('has not creased at all at the start of a run', () => {
    expect(foldProgress(ClockTuning.startingDeadheadTicks).completed).toBe(0);
    expect(foldedAreaFraction(foldInsets(ClockTuning.startingDeadheadTicks))).toBe(1);
  });

  it('creases progressively as the bank drains', () => {
    let previous = 1;
    for (let s = 0; s <= 180; s += 10) {
      const area = foldedAreaFraction(foldInsets(afterSeconds(s).deadheadTicks));
      expect(area).toBeLessThanOrEqual(previous + 1e-9);
      previous = area;
    }
    expect(previous).toBeLessThan(1);
  });

  it('leaves between a half and three quarters of the field by the end', () => {
    // `DESIGN.md` §7.5, literally. This is the assertion that keeps
    // `depthPerFold` inside the design rather than drifting to whatever looked
    // good on one screen.
    const atEnd = foldedAreaFraction(foldInsets(0));
    expect(atEnd).toBeGreaterThanOrEqual(0.5);
    expect(atEnd).toBeLessThanOrEqual(0.75);
  });

  it('spaces creases 15–30 seconds apart, as §7.5 says', () => {
    for (let i = 1; i < 10; i += 1) {
      const gap = (foldStartTick(i) - foldStartTick(i - 1)) / TICK_HZ;
      expect(gap).toBeGreaterThanOrEqual(15);
      expect(gap).toBeLessThanOrEqual(30);
    }
  });

  it('closes in evenly, so the cab never drifts off the visible area', () => {
    // Creases cycle through the four edges. An uneven fold would slide the
    // remaining field away from the centre, taking the cab towards an edge —
    // the one thing the fold must never do.
    const insets = foldInsets(0);
    const values = [insets.top, insets.right, insets.bottom, insets.left];
    const spread = Math.max(...values) - Math.min(...values);
    expect(spread).toBeLessThanOrEqual(FeelTuning.depthPerFold + 1e-9);
  });

  it('never folds an edge past the cap', () => {
    // Guards the degenerate case: a bank that somehow ran far negative must not
    // fold the field out of existence.
    const insets = foldInsets(-100000);
    for (const v of [insets.top, insets.right, insets.bottom, insets.left]) {
      expect(v).toBeLessThanOrEqual(FeelTuning.maxInsetPerEdge);
    }
    expect(foldedAreaFraction(insets)).toBeGreaterThan(0);
  });

  it('eases each crease inward rather than popping it', () => {
    const firstFoldAt = foldStartTick(0) / TICK_HZ;
    const mid = foldInsets(afterSeconds(firstFoldAt + FeelTuning.creaseSeconds / 2).deadheadTicks);
    const done = foldInsets(afterSeconds(firstFoldAt + FeelTuning.creaseSeconds * 2).deadheadTicks);

    const midTotal = mid.top + mid.right + mid.bottom + mid.left;
    const doneTotal = done.top + done.right + done.bottom + done.left;

    expect(midTotal).toBeGreaterThan(0);
    expect(midTotal).toBeLessThan(doneTotal);
  });
});

describe('the fold pauses while carrying — the mechanic', () => {
  it('does not advance when the bank does not drain', () => {
    // THE point of driving the fold off DeadheadTicks rather than wall time.
    // `Car.DeadheadTicks` only decrements while empty (clock.ts:stepClocks), so
    // the world stops closing in the moment a passenger gets in. That is the
    // rule the player is meant to induce without being told it.
    const paused = afterSeconds(60);
    const a = foldInsets(paused.deadheadTicks);
    const b = foldInsets(paused.deadheadTicks); // bank unchanged = time carried
    expect(a).toStrictEqual(b);
  });

  it('elapsedEmptyTicks counts only drained time', () => {
    expect(elapsedEmptyTicks(ClockTuning.startingDeadheadTicks)).toBe(0);
    expect(elapsedEmptyTicks(0)).toBe(ClockTuning.startingDeadheadTicks);
    // A bank that never went below its start cannot produce negative elapsed.
    expect(elapsedEmptyTicks(ClockTuning.startingDeadheadTicks * 2)).toBe(0);
  });
});

describe('the accent wash', () => {
  it('is on when empty and fully off when carrying', () => {
    expect(feelFor(START).wash).toBe(FeelTuning.emptyWash);
    expect(feelFor({ ...START, carrying: true }).wash).toBe(0);
  });

  it('comes all the way back — the world is not permanently tinted', () => {
    // "Pick someone up and the world comes back — full colour." A residual
    // wash while carrying would make the reward for a pickup ambiguous.
    expect(FeelTuning.carryingWash).toBe(0);
  });
});

describe('end of run', () => {
  it('reports ended for an eliminated cab', () => {
    // `scene.ts:182` stops DRAWING an eliminated cab, and nothing else marks
    // the end — so without this the run finishes by the car silently vanishing,
    // which a playtester reads as a crash rather than as an ending.
    expect(feelFor({ ...START, eliminated: true }).ended).toBe(true);
    expect(feelFor(START).ended).toBe(false);
  });
});

describe('ease', () => {
  it('is frame-rate independent', () => {
    // One 100 ms step must land in the same place as ten 10 ms steps. A naive
    // per-frame lerp does not, and the feel pass would literally feel different
    // at 30 fps and 144 fps — the one bug a feel pass cannot survive.
    const oneBig = ease(0, 1, 0.5, 0.1);

    let many = 0;
    for (let i = 0; i < 10; i += 1) many = ease(many, 1, 0.5, 0.01);

    expect(many).toBeCloseTo(oneBig, 6);
  });

  it('converges toward the target without overshooting', () => {
    let v = 0;
    for (let i = 0; i < 200; i += 1) v = ease(v, 1, 0.2, 1 / 60);
    expect(v).toBeGreaterThan(0.99);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('snaps when handed a nonsense timestep rather than producing NaN', () => {
    expect(ease(0, 1, 0.5, Number.NaN)).toBe(1);
    expect(ease(0, 1, 0, 0.016)).toBe(1);
  });
});
