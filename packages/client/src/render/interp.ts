/**
 * `render/interp.ts` — drawing between two sim states.
 *
 * The sim runs at 30 Hz. Displays run at 60, 120, 144 or 240. Drawing the
 * latest sim state directly means the picture only changes 30 times a second,
 * and on a 144 Hz monitor the same frame is shown four or five times in a row —
 * which reads as stutter no matter how smooth the underlying motion is.
 *
 * So every frame renders **between** the last two sim states, at the fraction
 * `alpha` that `loop.ts` hands back. A cab a third of the way from where it was
 * to where it is gets drawn a third of the way. That single change is what makes
 * a 30 Hz simulation look like a 144 Hz one, and it is why `step()` returning a
 * *copy* (ADR 0004) is worth what it costs: keeping the previous state is free.
 *
 * ## Everything here is float, and nothing here is state
 *
 * Interpolated values are for drawing only. They are never written back, never
 * hashed, never sent. The sim's `int32` discipline stops at this file — which is
 * exactly why interpolation cannot introduce a desync no matter how wrong it is.
 *
 * ## The one that is not a straight lerp
 *
 * Angles wrap. A cab turning from 65,000 to 500 in `uint16` turn units has moved
 * forward through zero by 1,036 units, not backwards by 64,500 — and a naive
 * lerp spins it almost all the way round the wrong way, once per lap, forever.
 * {@link lerpAngle} takes the short way. It is the only interesting function
 * here and the only one that has ever been got wrong.
 */
import { FX_ONE, TURN } from '@deadhead/sim';

/** Linear interpolation between two numbers. */
export function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

/**
 * Interpolate a 16.16 fixed-point value into a float, for drawing.
 *
 * The division by `FX_ONE` happens here rather than at the call site so a
 * renderer never handles a raw fixed-point number and never has to remember
 * which scale it is in.
 */
export function lerpFixed(from: number, to: number, alpha: number): number {
  return lerp(from, to, alpha) / FX_ONE;
}

/**
 * Interpolate a `uint16` turn angle the short way around.
 *
 * The wrap is the whole point. Rotating from 65,000 to 500 is 1,036 units
 * forward through zero; a straight lerp treats it as 64,500 units backwards and
 * spins the cab almost a full turn the wrong way — once per lap, forever, and
 * only when crossing zero, which is why it survives casual testing.
 *
 * @returns a float in `[0, TURN)`, not an integer — it is a drawing angle.
 */
export function lerpAngle(from: number, to: number, alpha: number): number {
  const a = from & 0xffff;
  const b = to & 0xffff;

  // Signed shortest difference, in `(-TURN/2, TURN/2]`.
  const delta = (((b - a + TURN / 2) & 0xffff) - TURN / 2) | 0;

  const angle = a + delta * alpha;
  // A negative result is possible when interpolating backwards through zero.
  return ((angle % TURN) + TURN) % TURN;
}

/** Turn units to radians, for the one place a renderer needs them: `ctx.rotate`. */
export function angleToRadians(angle: number): number {
  return (angle / TURN) * Math.PI * 2;
}

/** A cab's drawable pose, interpolated between two sim states. */
export interface Pose {
  /** World units, float. */
  readonly x: number;
  readonly y: number;
  /** Turn units, float, in `[0, TURN)`. */
  readonly heading: number;
}

/**
 * Interpolate one cab's pose.
 *
 * Takes raw field values rather than a `World` so it can be tested without
 * building one, and so `C-04` can call it for traffic and passengers too.
 */
export function lerpPose(
  previous: { x: number; y: number; heading: number },
  current: { x: number; y: number; heading: number },
  alpha: number,
): Pose {
  return {
    x: lerpFixed(previous.x, current.x, alpha),
    y: lerpFixed(previous.y, current.y, alpha),
    heading: lerpAngle(previous.heading, current.heading, alpha),
  };
}

/**
 * How far apart two positions are, in world units — for deciding whether to
 * interpolate at all.
 *
 * A cab that was teleported (a respawn in `G-01`, a hard correction in `M-06`)
 * must **not** be interpolated: sliding it across the map over one frame is far
 * more jarring than a snap. `C-04` compares against a threshold and skips.
 *
 * Whole units and plain floats — this is render-side, so the ±181 squaring
 * bound (ADR 0003) does not apply here the way it does inside the sim.
 */
export function separation(
  previous: { x: number; y: number },
  current: { x: number; y: number },
): number {
  const dx = (current.x - previous.x) / FX_ONE;
  const dy = (current.y - previous.y) / FX_ONE;
  return Math.hypot(dx, dy);
}

/**
 * Whether two states are close enough that interpolating between them is
 * sensible.
 *
 * The threshold is generous — a cab covers at most one unit per tick under its
 * own power (`CarTuning.maxSpeed`), so anything past a few units is a teleport
 * rather than movement.
 */
export function shouldInterpolate(
  previous: { x: number; y: number },
  current: { x: number; y: number },
  maxUnits = 8,
): boolean {
  return separation(previous, current) <= maxUnits;
}
