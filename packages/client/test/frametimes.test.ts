import { describe, expect, it } from 'vitest';

import { BUDGET_60_MS, FrameTimes, SETTLE_SAMPLES } from '../src/debug/frametimes.js';

describe('FrameTimes', () => {
  it('reports nothing rather than NaN before any frame', () => {
    const summary = new FrameTimes().summary();
    expect(summary.count).toBe(0);
    expect(summary.meanFps).toBe(0);
    expect(summary.lowOnePercentFps).toBe(0);
    expect(Number.isNaN(summary.p99Ms)).toBe(false);
  });

  it('computes a straightforward mean', () => {
    const times = new FrameTimes();
    for (let i = 0; i < 10; i += 1) times.push(10);
    const summary = times.summary();
    expect(summary.meanMs).toBeCloseTo(10, 9);
    expect(summary.meanFps).toBeCloseTo(100, 9);
  });

  it('keeps only the most recent window', () => {
    const times = new FrameTimes(4);
    for (const ms of [100, 100, 100, 100, 5, 5, 5, 5]) times.push(ms);
    expect(times.count).toBe(4);
    expect(times.summary().meanMs).toBeCloseTo(5, 9);
  });

  it('does not let an unfilled buffer drag zeros into the percentiles', () => {
    // The subarray in summary() exists for this. Sorting the whole capacity
    // would put 236 zeros ahead of four real samples and report a p50 of 0 —
    // a perfect frame rate, produced entirely by empty space.
    const times = new FrameTimes(240);
    for (const ms of [16, 17, 16, 18]) times.push(ms);
    const summary = times.summary();
    expect(summary.count).toBe(4);
    expect(summary.p50Ms).toBeGreaterThan(0);
    expect(summary.meanMs).toBeCloseTo(16.75, 9);
  });

  it('exposes the tail that a mean hides', () => {
    // The reason this file reports percentiles at all. Fifty-nine frames at
    // 10 ms and one at 200 ms averages a comfortable ~90 fps while the player
    // sees a visible hitch every second.
    const times = new FrameTimes(100);
    for (let i = 0; i < 99; i += 1) times.push(10);
    times.push(200);

    const summary = times.summary();
    expect(summary.meanFps).toBeGreaterThan(80); // the flattering number
    expect(summary.maxMs).toBe(200);
    expect(summary.lowOnePercentFps).toBeLessThan(15); // the honest one

    // And the distinction that caught a real bug: p99Ms is the value 99% of
    // frames fall BELOW, so here it is 10 ms — the fast frames. The 1% low is
    // the average of the 1% ABOVE it. Deriving one from the other reported a
    // serene 100 fps for a game hitching once a second.
    expect(summary.p99Ms).toBe(10);
    expect(1000 / summary.p99Ms).toBeGreaterThan(90);
    expect(summary.lowOnePercentFps).not.toBeCloseTo(1000 / summary.p99Ms, 1);
  });

  it('counts frames that missed the 60 Hz deadline', () => {
    const times = new FrameTimes(10);
    for (let i = 0; i < 5; i += 1) times.push(10);
    for (let i = 0; i < 5; i += 1) times.push(30);
    expect(times.summary(BUDGET_60_MS).missedFraction).toBeCloseTo(0.5, 9);
  });

  it('reports a sustained 60 as a 1% low of 60, not just a mean of 60', () => {
    // What "60 fps sustained" has to mean. A mean of 60 is consistent with a
    // third of frames missing the deadline; this is the check that is not.
    const times = new FrameTimes(120);
    for (let i = 0; i < 120; i += 1) times.push(16.6);

    const summary = times.summary();
    expect(summary.lowOnePercentFps).toBeGreaterThan(59);
    expect(summary.missedFraction).toBe(0);
  });

  it('fails a mean-of-60 that is really alternating fast and slow frames', () => {
    // The case the done-when has to reject. Mean is a healthy 60; every other
    // frame misses by a mile.
    const times = new FrameTimes(100);
    for (let i = 0; i < 50; i += 1) {
      times.push(3);
      times.push(30);
    }

    const summary = times.summary();
    expect(summary.meanFps).toBeGreaterThan(55);
    expect(summary.lowOnePercentFps).toBeLessThan(40);
    expect(summary.missedFraction).toBeCloseTo(0.5, 6);
  });

  it('orders the percentiles', () => {
    const times = new FrameTimes(200);
    for (let i = 0; i < 200; i += 1) times.push(5 + (i % 40));
    const summary = times.summary();
    expect(summary.p50Ms).toBeLessThanOrEqual(summary.p95Ms);
    expect(summary.p95Ms).toBeLessThanOrEqual(summary.p99Ms);
    expect(summary.p99Ms).toBeLessThanOrEqual(summary.maxMs);
  });

  it('sorts numerically, not as strings', () => {
    // Float64Array.sort is numeric; Array.prototype.sort is not. If this ever
    // moves to a plain array, "100" sorts before "9" and every percentile is
    // quietly wrong in a way that still looks like plausible frame times.
    const times = new FrameTimes(4);
    for (const ms of [9, 100, 20, 3]) times.push(ms);
    expect(times.summary().maxMs).toBe(100);
    expect(times.summary().p50Ms).toBe(9);
  });

  it('drops a backgrounded-tab sample instead of poisoning the window', () => {
    // A hidden tab, a resumed laptop or a paused debugger all produce absurd
    // deltas. One 40-second sample would dominate every percentile for the
    // next four seconds of play.
    const times = new FrameTimes(10);
    for (let i = 0; i < 10; i += 1) times.push(16);
    times.push(Number.POSITIVE_INFINITY);
    times.push(Number.NaN);
    times.push(-5);

    expect(times.count).toBe(10);
    expect(times.summary().maxMs).toBe(16);
  });

  it('refuses to call the 1% low meaningful on a short window', () => {
    // Below 100 samples the "worst 1%" rounds down to a single frame, so the
    // figure is just "slowest frame since load" — and the first frame after
    // startup is always slow (module parse, first paint, font warm-up). Without
    // this gate the number on screen for the first second of every run is
    // noise, and it is the number being stared at all day.
    const times = new FrameTimes(240);
    times.push(180); // the startup frame
    for (let i = 0; i < 30; i += 1) times.push(16);

    const early = times.summary();
    expect(early.settled).toBe(false);
    expect(early.lowOnePercentFps).toBeLessThan(10); // pinned to that one frame

    for (let i = 0; i < 100; i += 1) times.push(16);
    expect(times.summary().settled).toBe(true);

    // Still low, and correctly so — one 180 ms frame in 131 really is the worst
    // 1%. `settled` says the statistic is meaningful, not that it is good.
    expect(times.summary().lowOnePercentFps).toBeLessThan(10);

    // It recovers only once the stall ages out of the window, which is the
    // behaviour wanted: a hitch stays visible for the four seconds it takes to
    // scroll off, rather than being averaged away the instant it happens.
    for (let i = 0; i < 240; i += 1) times.push(16);
    expect(times.summary().lowOnePercentFps).toBeGreaterThan(50);
  });

  it('settles at exactly SETTLE_SAMPLES, not one either side', () => {
    const times = new FrameTimes(240);
    for (let i = 0; i < SETTLE_SAMPLES - 1; i += 1) times.push(16);
    expect(times.summary().settled).toBe(false);
    times.push(16);
    expect(times.summary().settled).toBe(true);
  });

  it('clears on reset', () => {
    const times = new FrameTimes(8);
    for (let i = 0; i < 8; i += 1) times.push(16);
    times.reset();
    expect(times.count).toBe(0);
    expect(times.summary().meanFps).toBe(0);
    expect(times.summary().settled).toBe(false);
  });

  it('rejects a nonsense capacity', () => {
    expect(() => new FrameTimes(0)).toThrow(RangeError);
    expect(() => new FrameTimes(2.5)).toThrow(RangeError);
  });
});

describe('histogram', () => {
  it('buckets by duration', () => {
    const times = new FrameTimes(10);
    for (const ms of [1, 1, 3, 5]) times.push(ms);
    const buckets = times.histogram(12, 2);
    expect(buckets[0]).toBe(2); // 0–2 ms
    expect(buckets[1]).toBe(1); // 2–4 ms
    expect(buckets[2]).toBe(1); // 4–6 ms
  });

  it('puts a long stall in the last bucket rather than off the chart', () => {
    // An open-ended final bucket. Otherwise a 300 ms stall — the single most
    // interesting sample on the screen — writes past the end of the array.
    const times = new FrameTimes(4);
    times.push(300);
    const buckets = times.histogram(12, 2);
    expect(buckets[11]).toBe(1);
    expect(buckets).toHaveLength(12);
  });

  it('counts every sample exactly once', () => {
    const times = new FrameTimes(50);
    for (let i = 0; i < 50; i += 1) times.push(i);
    const total = times.histogram(12, 2).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(50);
  });
});
