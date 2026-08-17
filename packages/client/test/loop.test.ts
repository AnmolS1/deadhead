import { describe, expect, it } from 'vitest';

import { TICK_HZ } from '@deadhead/sim';

import { FixedTimestepLoop, TICK_MS } from '../src/loop.js';

/**
 * Drive a loop with a synthetic display of a given refresh rate.
 *
 * No browser and no `requestAnimationFrame` — the loop takes timestamps and
 * returns counts precisely so this is testable, which is the only way `C-01`'s
 * done-when ("1800 ± 2 ticks on a 60 Hz *and* a 144 Hz display") can be checked
 * at all.
 */
function runDisplay(
  hz: number,
  seconds: number,
  options?: ConstructorParameters<typeof FixedTimestepLoop>[0],
): { loop: FixedTimestepLoop; frames: number; dropped: number } {
  const loop = new FixedTimestepLoop(options);
  const frameMs = 1000 / hz;
  const frames = Math.round(hz * seconds);

  let dropped = 0;
  for (let frame = 0; frame <= frames; frame += 1) {
    dropped += loop.advance(frame * frameMs).droppedTicks;
  }
  return { loop, frames, dropped };
}

// ---------------------------------------------------------------------------

describe('the sim runs at its own rate, whatever the display does', () => {
  it.each([30, 50, 60, 75, 90, 120, 144, 165, 240])(
    'runs 1800 ± 2 ticks over 60 seconds at %i Hz',
    (hz) => {
      // C-01's done-when. The same wall time must buy the same number of ticks
      // on every display, or the game is faster on better hardware — and every
      // recorded replay is worthless.
      const { loop, dropped } = runDisplay(hz, 60);

      expect(loop.tickCount).toBeGreaterThanOrEqual(1_798);
      expect(loop.tickCount).toBeLessThanOrEqual(1_802);
      expect(dropped).toBe(0);
    },
  );

  it('does not speed up on a high-refresh monitor', () => {
    // Stated separately from the range above because it is the actual failure
    // mode: passing the frame delta into step() would make 144 Hz run 2.4x
    // faster and every test that only checked "roughly 30 per second" would
    // still pass.
    const slow = runDisplay(60, 30).loop.tickCount;
    const fast = runDisplay(144, 30).loop.tickCount;
    expect(Math.abs(fast - slow)).toBeLessThanOrEqual(2);
  });

  it('holds over ten minutes without drifting', () => {
    // TICK_MS is 33.333…, so the accumulator carries a fraction forever. If
    // that fraction were mishandled the error would be invisible over a second
    // and obvious over a run.
    const { loop } = runDisplay(60, 600);
    const expected = 600 * TICK_HZ;
    expect(Math.abs(loop.tickCount - expected)).toBeLessThanOrEqual(2);
  });

  it('runs no ticks on the first frame', () => {
    // There is no previous frame to measure from. Inventing one would make the
    // first frame's step count depend on when the page happened to load.
    const loop = new FixedTimestepLoop();
    expect(loop.advance(12_345.678)).toEqual({ steps: 0, alpha: 0, droppedTicks: 0 });
  });

  it('runs no ticks for a frame shorter than a tick', () => {
    const loop = new FixedTimestepLoop();
    loop.advance(0);
    expect(loop.advance(TICK_MS / 2).steps).toBe(0);
    // ...and the second half of that tick still arrives.
    expect(loop.advance(TICK_MS).steps).toBe(1);
  });
});

describe('alpha', () => {
  it('stays in [0, 1)', () => {
    const loop = new FixedTimestepLoop();
    for (let frame = 0; frame < 2_000; frame += 1) {
      const { alpha } = loop.advance(frame * (1000 / 144));
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThan(1);
    }
  });

  it('measures the leftover, so the renderer can interpolate', () => {
    // Half a tick in means half way between the last two sim states — which is
    // what makes a 30 Hz sim look like a 144 Hz one (C-05).
    const loop = new FixedTimestepLoop();
    loop.advance(0);
    expect(loop.advance(TICK_MS * 1.5).alpha).toBeCloseTo(0.5, 6);
    expect(loop.advance(TICK_MS * 2.25).alpha).toBeCloseTo(0.25, 6);
  });

  it('runs the right tick on a boundary rather than deferring it', () => {
    // A subtracting accumulator gets alpha = 0.9999999999999996 here — a whole
    // tick deferred by a frame. Not asserted as exactly 0: TICK_MS is itself a
    // float, so an input of `TICK_MS * 3` is not exactly three ticks of time
    // and no implementation could return exactly 0 from it. What matters is
    // that the third tick runs now and alpha is at the bottom of its range.
    const loop = new FixedTimestepLoop();
    loop.advance(0);
    const advance = loop.advance(TICK_MS * 3);
    expect(advance.steps).toBe(3);
    expect(advance.alpha).toBeLessThan(1e-9);
  });

  it('does not drift over three hundred consecutive boundaries', () => {
    // The failure a subtracting accumulator shows only after many boundaries:
    // one tick per frame, every frame, with no missed or doubled step.
    const loop = new FixedTimestepLoop();
    loop.advance(0);
    for (let tick = 1; tick <= 300; tick += 1) {
      const advance = loop.advance(TICK_MS * tick);
      expect(advance.steps, `tick ${tick}`).toBe(1);
      expect(advance.alpha, `tick ${tick}`).toBeLessThan(1e-9);
    }
    expect(loop.tickCount).toBe(300);
  });
});

describe('the spiral-of-death guard', () => {
  it('caps how much catch-up one frame can do', () => {
    const loop = new FixedTimestepLoop({ maxCatchUpSteps: 8, maxFrameMs: 1_000 });
    loop.advance(0);
    // One frame owing 30 ticks, far past the cap of 8.
    const advance = loop.advance(1_000);
    expect(advance.steps).toBe(8);
    expect(advance.droppedTicks).toBe(22);
  });

  it('abandons the surplus rather than carrying it', () => {
    // Carrying the debt is the spiral: the next frame owes more, takes longer,
    // owes more again. Running slow for a moment is the survivable failure.
    const loop = new FixedTimestepLoop({ maxCatchUpSteps: 4 });
    loop.advance(0);
    const stall = loop.advance(1_000);
    expect(stall.steps).toBe(4);
    expect(stall.droppedTicks).toBe(26);

    // The next ordinary frame owes an ordinary number of ticks. If the surplus
    // had been carried it would owe 26 more and the stall would never end.
    const recovered = loop.advance(1_100);
    expect(recovered.steps).toBe(3);
    expect(recovered.droppedTicks).toBe(0);
  });

  it('clamps an enormous frame delta before counting it', () => {
    // A tab restored after ten minutes reports a ten-minute delta. Without the
    // clamp the guard would still hold, but droppedTicks would report a
    // nonsense number and C-06's overlay would lie.
    const loop = new FixedTimestepLoop({ maxCatchUpSteps: 8, maxFrameMs: 250 });
    loop.advance(0);
    const advance = loop.advance(600_000);

    // 250 ms is 7.5 ticks, so the frame clamp binds before the step cap does —
    // and droppedTicks reports single digits rather than eighteen thousand.
    expect(advance.steps).toBe(7);
    expect(advance.droppedTicks).toBe(0);
  });

  it('survives a timestamp that goes backwards', () => {
    // Some clocks do. Pretending otherwise means a negative accumulator and a
    // loop that quietly stops stepping.
    const loop = new FixedTimestepLoop();
    loop.advance(1_000);
    expect(loop.advance(900).steps).toBe(0);
    expect(loop.advance(1_000 + TICK_MS).steps).toBeGreaterThanOrEqual(1);
  });

  it('recovers its normal rate after a stall', () => {
    const loop = new FixedTimestepLoop();
    loop.advance(0);
    loop.advance(5_000);

    const before = loop.tickCount;
    for (let frame = 1; frame <= 600; frame += 1) loop.advance(5_000 + frame * (1000 / 60));
    // Ten seconds of clean 60 Hz frames buys ten seconds of ticks.
    expect(loop.tickCount - before).toBeGreaterThanOrEqual(10 * TICK_HZ - 2);
    expect(loop.tickCount - before).toBeLessThanOrEqual(10 * TICK_HZ + 2);
  });
});

describe('pause and reset', () => {
  it('does not bill the sim for time spent paused', () => {
    // G-09 pauses on blur. The first frame back must not owe the sim the whole
    // time the tab was hidden.
    const loop = new FixedTimestepLoop();
    loop.advance(0);
    loop.advance(1_000);
    const atPause = loop.tickCount;

    loop.resume();
    loop.advance(60_000);
    expect(loop.tickCount).toBe(atPause);

    expect(loop.advance(60_000 + TICK_MS).steps).toBe(1);
  });

  it('starts fresh after a reset', () => {
    const loop = new FixedTimestepLoop();
    loop.advance(0);
    loop.advance(1_000);
    expect(loop.tickCount).toBeGreaterThan(0);

    loop.reset();
    expect(loop.tickCount).toBe(0);
    expect(loop.advance(999_999)).toEqual({ steps: 0, alpha: 0, droppedTicks: 0 });
  });
});

describe('the boundary', () => {
  it('never hands the sim a wall-clock number', () => {
    // The property this whole file exists for, asserted on the shape of the
    // return value: `steps` is a count and `alpha` is render-only. There is no
    // path by which a millisecond reaches step().
    const loop = new FixedTimestepLoop();
    loop.advance(0);
    const advance = loop.advance(123.456);

    expect(Number.isInteger(advance.steps)).toBe(true);
    expect(Number.isInteger(advance.droppedTicks)).toBe(true);
    expect(Object.keys(advance).sort()).toEqual(['alpha', 'droppedTicks', 'steps']);
  });

  it('agrees with the sim about the tick rate', () => {
    expect(TICK_MS).toBe(1000 / TICK_HZ);
    expect(TICK_HZ).toBe(30);
  });
});
