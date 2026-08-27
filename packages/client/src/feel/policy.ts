/**
 * `feel/policy.ts` — `C-08`, as pure functions.
 *
 * Same split as `audio/policy.ts`, for the same reason: the decisions are
 * arithmetic over sim state and get tested; the drawing is thin and gets looked
 * at. `DESIGN.md` calls this the most important non-technical task in the
 * project, which is exactly why the parts that *can* be pinned down should be.
 *
 * **The fold is driven by the deadhead bank, not by wall time.** `D-04` says
 * "the fold is the clock" and "the clock running out and the map going dark
 * become the same event", and `Car.DeadheadTicks` only decrements while the cab
 * is empty. So the world stops closing in the moment a passenger gets in, and
 * starts again when they get out. That is the mechanic teaching itself with no
 * UI at all — which is the whole brief.
 *
 * **The fold is also the vignette.** The spec lists "the vignette tightens" as a
 * separate beat, but `render/paper.ts` is explicit that the art uses no
 * gradients — "a fold is a hard discontinuity; a gradient is what paper does
 * not do". A soft radial darkening would be the one thing in the game that
 * isn't paper. Paper closing in from the edges does the same job in the idiom.
 */
import { ClockTuning, TICK_HZ } from '@deadhead/sim';

export const FeelTuning = {
  /**
   * Seconds of empty-cab time between creases, cycled by fold index.
   *
   * `DESIGN.md` §7.5 says "every 15–30 seconds". Fixed and cycling rather than
   * random: a fold is a large, startling event, and a player who cannot build
   * *any* expectation of when the next one lands reads it as glitching rather
   * than as a clock. Varying within the band keeps it from being metronomic.
   */
  intervalsSeconds: [18, 24, 16, 28, 20, 22] as const,

  /**
   * Fraction of the viewport one crease takes off one edge.
   *
   * Chosen so a full run lands inside §7.5's "between a half and three quarters
   * of the original field". `foldedAreaFraction` asserts that, and a test pins
   * it — so this number cannot drift out of the design's range unnoticed.
   */
  depthPerFold: 0.037,

  /** No edge may be folded past this, so the cab is never occluded. */
  maxInsetPerEdge: 0.3,

  /** Seconds a crease takes to travel inward. A fold that pops reads as a bug. */
  creaseSeconds: 1.4,

  /**
   * Accent wash while empty, as an alpha.
   *
   * "Colour desaturates toward the accent" (`DESIGN.md` §2.1). A flat wash of
   * `Ink.crane` over the scene, not a saturation filter: `filter` on a 2D
   * context is expensive per frame and absent from the test double, and a wash
   * is what a coloured sheet laid over paper actually looks like.
   *
   * **0.06, not 0.13.** The first value was picked by reasoning and looked
   * badly wrong on screen: it turned the whole city salmon and destroyed the
   * cool paper identity `W-05` established, and — worse — it made the empty
   * state read as *warmer and prettier* rather than as more anxious. The
   * base palette is already nearly monochrome, so it takes very little tint to
   * shift it. Judge this one by looking, never by argument.
   */
  emptyWash: 0.06,

  /** Wash while carrying. Zero — the world comes all the way back. */
  carryingWash: 0,

  /** How long the wash takes to cross-fade on a pickup or drop-off, in seconds. */
  washSeconds: 0.5,
} as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Ticks of empty-cab time spent so far this run. */
export function elapsedEmptyTicks(deadheadTicks: number): number {
  const spent = ClockTuning.startingDeadheadTicks - deadheadTicks;
  return spent > 0 ? spent : 0;
}

/**
 * Ticks at which fold `index` (0-based) *begins*.
 *
 * Cumulative over {@link FeelTuning.intervalsSeconds}, cycling. Exported
 * because the test asserts the whole schedule fits a run rather than checking
 * one arbitrary moment.
 */
export function foldStartTick(index: number): number {
  let ticks = 0;
  for (let i = 0; i <= index; i += 1) {
    const seconds = FeelTuning.intervalsSeconds[i % FeelTuning.intervalsSeconds.length] ?? 20;
    ticks += seconds * TICK_HZ;
  }
  return ticks;
}

/** How many creases have started, and how far the newest one has travelled. */
export interface FoldProgress {
  /** Creases fully landed. */
  readonly completed: number;
  /** Progress of the in-flight crease, in [0, 1]. */
  readonly partial: number;
}

export function foldProgress(deadheadTicks: number): FoldProgress {
  const elapsed = elapsedEmptyTicks(deadheadTicks);

  let completed = 0;
  // Bounded by the run length over the shortest interval — a dozen or so.
  // A `while (true)` here would spin if a tuning edit ever made an interval 0.
  for (let i = 0; i < 64; i += 1) {
    if (foldStartTick(i) > elapsed) break;
    completed = i + 1;
  }

  const creaseTicks = FeelTuning.creaseSeconds * TICK_HZ;
  // The in-flight crease is the one whose start has passed within `creaseTicks`.
  const since = elapsed - (completed > 0 ? foldStartTick(completed - 1) : -Infinity);
  const partial = completed > 0 && since < creaseTicks ? clamp01(since / creaseTicks) : 1;

  return { completed, partial };
}

/** Inset of each edge, as a fraction of the viewport. */
export interface FoldInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

const EDGES = ['top', 'right', 'bottom', 'left'] as const;

/**
 * Per-edge insets for a given bank.
 *
 * Creases cycle through the four edges so the field closes in evenly rather
 * than sliding off to one side — an uneven fold would move the cab away from
 * the centre of what is still visible, which is the one thing the fold must
 * never do.
 */
export function foldInsets(deadheadTicks: number): FoldInsets {
  const { completed, partial } = foldProgress(deadheadTicks);
  const depth = { top: 0, right: 0, bottom: 0, left: 0 };

  for (let i = 0; i < completed; i += 1) {
    const edge = EDGES[i % EDGES.length]!;
    // The newest crease is still travelling; every earlier one has landed.
    const amount =
      i === completed - 1 ? FeelTuning.depthPerFold * partial : FeelTuning.depthPerFold;
    depth[edge] += amount;
  }

  const cap = FeelTuning.maxInsetPerEdge;
  return {
    top: Math.min(depth.top, cap),
    right: Math.min(depth.right, cap),
    bottom: Math.min(depth.bottom, cap),
    left: Math.min(depth.left, cap),
  };
}

/** Fraction of the original play field still visible. */
export function foldedAreaFraction(insets: FoldInsets): number {
  const w = 1 - insets.left - insets.right;
  const h = 1 - insets.top - insets.bottom;
  return clamp01(w) * clamp01(h);
}

/**
 * The deadhead clock as `M:SS`.
 *
 * **Added 2026-08-27 after Anmol's first playtest.** `D-04` made the fold the
 * clock and §7.5 says "a numeric clock stays available somewhere, but the fold
 * is what a player actually reads" — so this exercises a permission the design
 * already granted rather than reversing it. What the playtest found is that the
 * fold conveys *urgency* without conveying *magnitude*: a crease every 15–30
 * seconds cannot tell you whether you have twenty seconds left or ninety, and
 * pressure you cannot size reads as stress rather than as a deadline.
 *
 * This is deliberately the ONLY number on screen. `G-02` owns the real HUD
 * (cash, deliveries, fare state) and it is behind `G-01`; adding a second value
 * here would mean designing `G-02` inside `C-08`, and the feel pass would then
 * be testing a HUD.
 *
 * Rounds UP, so the last visible second is `0:01` and `0:00` means the run is
 * genuinely over. A clock that shows `0:00` while still driving reads as broken.
 */
export function clockLabel(deadheadTicks: number): string {
  const ticks = deadheadTicks > 0 ? deadheadTicks : 0;
  const seconds = Math.ceil(ticks / TICK_HZ);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest}`;
}

/** Everything the feel renderer needs for one frame. */
export interface FeelState {
  readonly carrying: boolean;
  readonly deadheadTicks: number;
  readonly eliminated: boolean;
}

export interface Feel {
  readonly insets: FoldInsets;
  /** The deadhead clock, `M:SS`. See {@link clockLabel}. */
  readonly clock: string;
  /**
   * True while the clock is frozen because a passenger is aboard.
   *
   * The renderer dims it. **A visibly stopped number is the least ambiguous
   * statement of `C-08`'s pass condition available** — "the timer stops when
   * someone's in the car" is exactly what a frozen clock says, and it says it
   * without a word of instruction.
   */
  readonly clockHeld: boolean;
  /** Alpha of the accent wash, in [0, 1]. */
  readonly wash: number;
  /** True once the run is over — the renderer draws the terminal state. */
  readonly ended: boolean;
}

/**
 * The whole visual feel for one moment.
 *
 * The wash is a *target*; `render/feel.ts` eases toward it so a pickup is a
 * half-second bloom of colour rather than an instant snap. Easing here would
 * mean this function had state, and then it could not be tested by calling it.
 */
export function feelFor(state: FeelState): Feel {
  return {
    insets: foldInsets(state.deadheadTicks),
    wash: state.carrying ? FeelTuning.carryingWash : FeelTuning.emptyWash,
    ended: state.eliminated,
    clock: clockLabel(state.deadheadTicks),
    clockHeld: state.carrying,
  };
}

/**
 * One step of an exponential ease toward a target.
 *
 * Frame-rate independent: the same wall-clock duration produces the same result
 * at 30 fps and 144 fps. A naive `current += (target - current) * 0.1` per frame
 * does not, and would make the feel pass literally feel different on different
 * machines — which is the one bug a feel pass cannot survive.
 */
export function ease(current: number, target: number, seconds: number, dtSeconds: number): number {
  if (seconds <= 0 || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return target;
  const k = 1 - Math.exp(-dtSeconds / seconds);
  return current + (target - current) * k;
}
