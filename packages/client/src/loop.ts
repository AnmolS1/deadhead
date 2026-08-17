/**
 * `loop.ts` — the fixed-timestep accumulator.
 *
 * `requestAnimationFrame` drives **rendering**. It never drives the sim.
 *
 * That distinction is the whole file. A frame callback fires at whatever rate
 * the display runs — 60 Hz, 120 Hz, 144 Hz, or 3 Hz while a tab is throttled —
 * and the naive thing to do is pass the elapsed time into the simulation. Doing
 * that would mean the game runs faster on a better monitor, and it would mean
 * `step()` takes a `dt` it cannot represent: 1/30 is not expressible in 16.16
 * (`constants.ts`), and a replay recorded on one machine would not reproduce on
 * another. Determinism and frame rate have to be completely separated, and the
 * accumulator is how.
 *
 * Real time goes in. Whole ticks come out. Whatever is left over becomes
 * `alpha`, the fraction between the last two sim states, which `C-05` uses to
 * interpolate so a 30 Hz simulation looks like a 144 Hz one.
 *
 * ## Derived from the total, never subtracted
 *
 * The obvious accumulator — add the frame delta, subtract `1000/30` per tick —
 * does not work. `1000/30` is 33.333…, so repeated subtraction leaves a residue
 * that can sit a hair *below* one tick, deferring a step by a frame and pushing
 * `alpha` to 0.9999999999999996. It self-corrects within a second, so a "1800
 * ticks per minute" test never notices; the renderer notices, because for one
 * frame it interpolates to essentially the next state.
 *
 * Quantising to integer microseconds does not fix it either — a tick is
 * 33,333.33 µs, so rounding to whole microseconds can lose enough to defer a
 * tick that landed exactly on the boundary. (Tried; the tests caught it.)
 *
 * What works is not subtracting at all. Total elapsed time is kept, and the
 * tick number is *derived* from it: `floor(total × TICK_HZ / 1000)`. Error
 * cannot accumulate because nothing accumulates — each frame recomputes the
 * answer from scratch. Ten minutes in, the count is still exact.
 *
 * Real time exists in this file and nowhere past it. `advance` returns a
 * *count*; the caller runs that many `step()` calls with no argument derived
 * from wall time.
 */
import { TICK_HZ } from '@deadhead/sim';

/**
 * Milliseconds per simulation tick — 33.333… at 30 Hz.
 *
 * Exported for tests and for `C-06`'s overlay. **Not used by the accumulator**,
 * which works in exact integers; see the note above.
 */
export const TICK_MS = 1000 / TICK_HZ;

const MS_PER_SECOND = 1000;

export interface LoopOptions {
  /**
   * Most sim steps to run in one frame.
   *
   * The spiral-of-death guard. If a frame takes longer than the ticks it owes —
   * a background tab, a long GC pause, a laptop lid — the accumulator grows,
   * so the next frame runs more steps, which takes longer still. Left alone it
   * never recovers. Capping the catch-up means the sim silently runs slow for a
   * moment instead, which is the right failure: a dropped second is survivable,
   * a locked tab is not.
   *
   * Eight is about a quarter-second of catch-up at 30 Hz.
   *
   * Must be comfortably under `maxFrameMs / TICK_MS`, or the frame clamp binds
   * first and this cap is dead code — which it was, at the original defaults of
   * 8 steps and 250 ms. A test asserting the exact cap is what found it.
   */
  readonly maxCatchUpSteps?: number;

  /**
   * Largest single frame delta to believe, in milliseconds.
   *
   * A tab restored after ten minutes reports a ten-minute delta. Without this,
   * the loop would try to run 18,000 ticks and be killed by the guard above
   * anyway — but it would also mean `droppedTicks` reported a nonsense number.
   * Clamping first keeps the accounting honest.
   *
   * One second: long enough that a real hitch is caught up rather than
   * discarded, and comfortably above `maxCatchUpSteps` worth of ticks so both
   * guards do their own job.
   */
  readonly maxFrameMs?: number;
}

export interface Advance {
  /** Whole sim ticks owed for this frame. The caller runs exactly this many `step()` calls. */
  readonly steps: number;
  /**
   * Fraction of the way from the previous sim state to the current one, in
   * `[0, 1)`. `C-05` renders `lerp(previous, current, alpha)`.
   */
  readonly alpha: number;
  /**
   * Ticks abandoned because the catch-up cap was hit.
   *
   * Non-zero means the machine could not keep up, and `C-06`'s overlay should
   * say so. In multiplayer it also matters: a client that drops ticks locally
   * has not lost sync — the server is authoritative — but it *has* stopped
   * predicting accurately, and `M-06` wants to know.
   */
  readonly droppedTicks: number;
}

/**
 * A fixed-timestep accumulator.
 *
 * Deliberately has no idea what a frame is. It takes timestamps and returns
 * counts, so it can be tested against a synthetic 144 Hz display without a
 * browser — which is exactly how `C-01`'s done-when is checked.
 */
export class FixedTimestepLoop {
  /** Total un-paused wall time seen, in milliseconds. */
  private elapsedMs = 0;
  /** Ticks the loop has decided about, including any it dropped. */
  private accountedTicks = 0;
  private lastTimestampMs: number | null = null;

  private readonly maxCatchUpSteps: number;
  private readonly maxFrameMs: number;

  /** Sim ticks actually stepped. Excludes dropped ticks, which were never simulated. */
  private ranTicks = 0;

  constructor(options: LoopOptions = {}) {
    this.maxCatchUpSteps = options.maxCatchUpSteps ?? 8;
    this.maxFrameMs = options.maxFrameMs ?? 1_000;
  }

  /** Total sim ticks this loop has asked for. */
  get tickCount(): number {
    return this.ranTicks;
  }

  /**
   * Take a frame timestamp and report the work it owes.
   *
   * The first call establishes the origin and returns no steps — there is no
   * previous frame to measure from, and inventing one would make the first
   * frame's step count depend on when the page happened to load.
   */
  advance(timestampMs: number): Advance {
    if (this.lastTimestampMs === null) {
      this.lastTimestampMs = timestampMs;
      return { steps: 0, alpha: 0, droppedTicks: 0 };
    }

    // A timestamp that goes backwards is not something to reason about — some
    // clocks do it, and pretending otherwise means time running in reverse.
    const elapsedMs = Math.max(0, Math.min(timestampMs - this.lastTimestampMs, this.maxFrameMs));
    this.lastTimestampMs = timestampMs;
    this.elapsedMs += elapsedMs;

    // Derived, not decremented. This is the whole trick.
    const exact = (this.elapsedMs * TICK_HZ) / MS_PER_SECOND;
    const due = Math.floor(exact);

    let steps = due - this.accountedTicks;
    let droppedTicks = 0;
    if (steps > this.maxCatchUpSteps) {
      droppedTicks = steps - this.maxCatchUpSteps;
      steps = this.maxCatchUpSteps;
    }

    // Everything up to `due` is accounted for whether it ran or not. Carrying
    // the surplus instead is the spiral: the next frame owes more, takes longer,
    // owes more again.
    this.accountedTicks = due;
    this.ranTicks += steps;

    return { steps, alpha: exact - due, droppedTicks };
  }

  /**
   * Forget the last timestamp without touching the accumulator.
   *
   * For resuming after a pause — `G-09` pauses on blur — so the first frame
   * back does not bill the sim for the time the tab spent hidden.
   */
  resume(): void {
    this.lastTimestampMs = null;
  }

  /** Reset everything. A new run starts a new loop. */
  reset(): void {
    this.elapsedMs = 0;
    this.accountedTicks = 0;
    this.lastTimestampMs = null;
    this.ranTicks = 0;
  }
}
