/**
 * `debug/frametimes.ts` — how long frames actually take.
 *
 * `C-04`'s done-when is *"60 fps with 12 cars, 40 NPC vehicles and 200
 * particles"*. This is what decides whether that is true, so it is worth being
 * precise about what it measures.
 *
 * ## Mean FPS is the wrong statistic, and it hides exactly this bug
 *
 * A game that renders fifty-nine frames in 10 ms and one in 200 ms averages a
 * comfortable 90 fps. The player sees a visible hitch every second. Averaging
 * is precisely the operation that destroys the information you need, because
 * the frames that matter are the slow ones and there are few of them.
 *
 * So this reports **percentiles**, and the headline number is the 1% low —
 * the frame rate of the worst one frame in a hundred. "60 fps sustained" means
 * the 1% low is 60, not that the mean is. A mean of 60 is consistent with a
 * third of frames missing the deadline.
 *
 * ## A ring buffer, because allocation is the thing being measured
 *
 * The overlay runs inside the frame it is timing. Growing an array or
 * allocating a stats object every frame would put garbage-collector pauses into
 * the numbers — the measurement causing the stutter it reports. So samples go
 * into a fixed `Float64Array` and {@link FrameTimes.summary} is the only thing
 * that allocates, called once per overlay repaint rather than once per frame.
 */

/** How many frames to keep. At 60 fps this is about four seconds of history. */
export const DEFAULT_CAPACITY = 240;

export interface FrameSummary {
  /** Samples this summary is built from. */
  readonly count: number;
  /** Mean frame time, ms. Reported for completeness; do not judge by it. */
  readonly meanMs: number;
  /** Median frame time, ms. */
  readonly p50Ms: number;
  /** 95th percentile frame time, ms. */
  readonly p95Ms: number;
  /** 99th percentile frame time, ms. */
  readonly p99Ms: number;
  /** Slowest frame in the window, ms. */
  readonly maxMs: number;
  /** Mean frame rate. The flattering number. */
  readonly meanFps: number;
  /**
   * The "1% low" — frame rate of the **worst one percent of frames**, averaged.
   *
   * **The number to judge by.** "60 fps sustained" has to mean this is 60; a
   * mean of 60 is consistent with a third of frames missing the deadline.
   *
   * Deliberately *not* derived from {@link p99Ms}, which is a different
   * statistic pointing the other way. `p99Ms` is the value 99% of frames fall
   * **below**; the 1% low is the average of the 1% that fall **above** it. With
   * ninety-nine 10 ms frames and one 200 ms stall, `p99Ms` is 10 ms and the 1%
   * low is 200 ms — and the first draft here computed `1000 / p99Ms`, which
   * reported a serene 100 fps for a game hitching once a second. The name said
   * one thing and the arithmetic did another.
   */
  readonly lowOnePercentFps: number;
  /** Fraction of frames that missed a 60 Hz deadline, in `[0, 1]`. */
  readonly missedFraction: number;
  /**
   * Whether there are enough samples for {@link lowOnePercentFps} to mean
   * anything. **The overlay must show a dash rather than a number when this is
   * false.**
   *
   * Below {@link SETTLE_SAMPLES} frames the "worst 1%" rounds down to a single
   * frame, so the figure is just "the slowest frame since load" — and the first
   * frame after startup is always slow (module parse, first paint, shader and
   * font warm-up). Without this gate the number displayed for the first second
   * of every single run is noise, and it is the number being stared at all day.
   */
  readonly settled: boolean;
}

/**
 * Samples needed before the 1% low is meaningful.
 *
 * At 100, the worst 1% is one frame out of a hundred — which is what "1% low"
 * means. At 60 fps this is reached about 1.7 s after a run starts.
 */
export const SETTLE_SAMPLES = 100;

/** A frame at 60 Hz has this long to finish. */
export const BUDGET_60_MS = 1000 / 60;

/**
 * A fixed-size ring of recent frame durations.
 *
 * Push one sample per rendered frame; ask for a {@link summary} only when the
 * overlay repaints.
 */
export class FrameTimes {
  private readonly samples: Float64Array;
  /** Scratch buffer for sorting, so `summary` does not allocate per call. */
  private readonly sorted: Float64Array;
  private writeIndex = 0;
  private filled = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('capacity must be a positive integer');
    }
    this.samples = new Float64Array(capacity);
    this.sorted = new Float64Array(capacity);
  }

  get capacity(): number {
    return this.samples.length;
  }

  /** Samples currently held, up to {@link capacity}. */
  get count(): number {
    return this.filled;
  }

  /**
   * Record one frame.
   *
   * Non-finite and negative durations are dropped rather than stored. A
   * backgrounded tab, a resumed laptop or a paused debugger all produce
   * absurd deltas, and a single 40-second sample would dominate every
   * percentile in the window for the next four seconds of play.
   */
  push(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;

    this.samples[this.writeIndex] = durationMs;
    this.writeIndex = (this.writeIndex + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled += 1;
  }

  /** Forget everything. For a resize, a pause, or a fresh run. */
  reset(): void {
    this.writeIndex = 0;
    this.filled = 0;
  }

  /**
   * Percentiles over the current window.
   *
   * Allocates one object; call it when the overlay repaints, not every frame.
   */
  summary(budgetMs: number = BUDGET_60_MS): FrameSummary {
    const count = this.filled;
    if (count === 0) {
      return {
        count: 0,
        meanMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        meanFps: 0,
        lowOnePercentFps: 0,
        missedFraction: 0,
        settled: false,
      };
    }

    let total = 0;
    let missed = 0;
    for (let i = 0; i < count; i += 1) {
      const sample = this.samples[i]!;
      this.sorted[i] = sample;
      total += sample;
      if (sample > budgetMs) missed += 1;
    }

    // Only the filled prefix is meaningful; sorting the whole array would drag
    // the zeros from an unfilled buffer into the percentiles.
    const window = this.sorted.subarray(0, count);
    window.sort();

    const meanMs = total / count;

    // The worst 1%, averaged — at least one frame, so a short window still
    // reports its slowest rather than dividing by zero.
    const worstCount = Math.max(1, Math.round(count * 0.01));
    let worstTotal = 0;
    for (let i = count - worstCount; i < count; i += 1) worstTotal += window[i]!;
    const worstMeanMs = worstTotal / worstCount;

    return {
      count,
      meanMs,
      p50Ms: percentile(window, 0.5),
      p95Ms: percentile(window, 0.95),
      p99Ms: percentile(window, 0.99),
      maxMs: window[count - 1]!,
      meanFps: meanMs > 0 ? 1000 / meanMs : 0,
      lowOnePercentFps: worstMeanMs > 0 ? 1000 / worstMeanMs : 0,
      missedFraction: missed / count,
      settled: count >= SETTLE_SAMPLES,
    };
  }

  /**
   * Bucketed counts, for the histogram the overlay draws.
   *
   * Buckets are `bucketMs` wide and the last one is open-ended, so a 300 ms
   * stall lands somewhere visible instead of off the end of the chart.
   */
  histogram(bucketCount = 12, bucketMs = 2): Int32Array {
    const buckets = new Int32Array(bucketCount);
    for (let i = 0; i < this.filled; i += 1) {
      const index = Math.min(bucketCount - 1, Math.floor(this.samples[i]! / bucketMs));
      buckets[index] += 1;
    }
    return buckets;
  }
}

/**
 * Nearest-rank percentile over an already-sorted window.
 *
 * Nearest-rank rather than interpolated: with 240 samples the difference is
 * invisible, and this way every value reported is a frame time that genuinely
 * occurred rather than a number between two that did.
 */
function percentile(sortedWindow: Float64Array, fraction: number): number {
  const count = sortedWindow.length;
  const rank = Math.ceil(fraction * count);
  const index = Math.min(count - 1, Math.max(0, rank - 1));
  return sortedWindow[index]!;
}
