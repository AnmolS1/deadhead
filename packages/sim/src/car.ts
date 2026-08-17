/**
 * `car.ts` — the arcade car model.
 *
 * No physics engine, no rigid bodies, no solver. An arcade driving feel is a
 * small number of hand-tuned rules, and a solver would make it *harder* to get
 * right as well as harder to make deterministic.
 *
 * ## Where the drift lives
 *
 * The car has two directions, and keeping them separate is the whole model:
 *
 * - **Heading** — where the cab points. Steering rotates this.
 * - **Velocity** — where the cab is actually going. Only friction and thrust
 *   change this.
 *
 * Each tick the velocity is decomposed into a component *along* the heading and
 * a component *across* it. The forward component gets throttle, brake and drag.
 * The lateral component gets multiplied by a grip factor below 1.0 — that is
 * the entire drift mechanic. Grip near 1.0 slides for a long time; grip near
 * 0.0 is on rails. The handbrake simply swaps in a lower grip.
 *
 * A car that is sliding therefore points one way and travels another, which is
 * what a player reads as drift, and it costs two multiplies.
 *
 * ## Units
 *
 * Everything is 16.16 fixed point, and every rate is **per tick** — velocity is
 * units/tick, acceleration is units/tick². There is no `dt` to multiply by; see
 * `constants.ts` for why a fixed-point dt cannot exist at 30 Hz. The tuning
 * table below is authored in per-second terms and converted once, at module
 * load, by `fxFromRatio`.
 *
 * ## Staying inside the envelope
 *
 * `fxMul` overflows above ±181 units (ADR 0003). Velocities and accelerations
 * are small — a few units per tick at most — so products here are nowhere near
 * it. Positions are not: they reach ±2048, and **nothing in this file ever
 * multiplies a position by anything.** Positions are only ever added to.
 */
import { Input, hasInput } from '@deadhead/proto';

import {
  FX_ONE,
  fxAbs,
  fxAtan2,
  fxCos,
  fxDiv,
  fxFromInt,
  fxFromRatio,
  fxMul,
  fxSin,
  fxSqrt,
} from './fx.js';
import { WORLD_MAX, WORLD_MIN } from './constants.js';
import { Car, CarFlags, getCar, setCar, type World } from './world.js';

/**
 * The tuning table. Every constant the feel depends on, in one exported object
 * so `C-06` can put sliders on it and paste the result back.
 *
 * **These are the numbers to change to make the car feel different. Nothing
 * else in this file should need touching.**
 *
 * Each value is **authored in per-second terms and stored per tick** — the
 * `fxFromRatio(48, 30 * 30)` form reads as "48 units/s², at 30 Hz". The
 * conversion happens once, here, at module load. Never at runtime: that would
 * be the fixed-point `dt` this project deliberately does not have
 * (`constants.ts`).
 */
export const CarTuning = {
  /** Forward acceleration under throttle, units/s². */
  acceleration: fxFromRatio(48, 30 * 30),

  /** Deceleration under brake, units/s². Stronger than the engine, as in any car. */
  braking: fxFromRatio(96, 30 * 30),

  /** Reverse acceleration when braking from a standstill, units/s². */
  reverse: fxFromRatio(24, 30 * 30),

  /** Passive drag applied to the forward component each tick, as a fraction of 1.0. */
  drag: fxFromRatio(994, 1000),

  /**
   * Fraction of lateral velocity that **survives** each tick. This is the drift
   * knob, and it is named for what it does rather than for grip, which reads
   * backwards: closer to 1.0 slides further, closer to 0 is on rails.
   */
  lateralSlide: fxFromRatio(720, 1000),

  /** Lateral survival while the handbrake is down. Higher means a longer slide. */
  handbrakeSlide: fxFromRatio(960, 1000),

  /** Steering rate at low speed, turn units per tick. */
  steerRate: fxFromInt(360),

  /**
   * Speed at which steering authority has fallen to half, units/tick.
   * Keeps the car from spinning on the spot at speed.
   */
  steerFalloffSpeed: fxFromRatio(18, 30),

  /** Hard cap on speed, units/tick. */
  maxSpeed: fxFromRatio(30, 30),

  /** Hard cap on reverse speed, units/tick. */
  maxReverseSpeed: fxFromRatio(9, 30),

  /** Below this, the car is snapped to rest so it cannot creep. */
  restSpeed: fxFromRatio(1, 30 * 8),
} as const;

/** Lateral speed, in units/tick, above which {@link CarFlags.Drifting} is set. */
const DRIFT_THRESHOLD = fxFromRatio(4, 30);

/**
 * Advance one cab by one tick.
 *
 * Mutates `world` in place — it is called by `step()` on the *copy* it already
 * made, never on a world anyone else holds. See ADR 0004.
 */
export function stepCar(world: World, slot: number): void {
  const input = getCar(world, slot, Car.LastInput);

  const velocityX = getCar(world, slot, Car.VelocityX);
  const velocityY = getCar(world, slot, Car.VelocityY);
  const heading = getCar(world, slot, Car.Heading) & 0xffff;

  // --- steer first ---------------------------------------------------------
  //
  // Order matters more than anything else in this function. Steering has to
  // happen BEFORE the velocity is decomposed, because the entire model rests on
  // the velocity vector *not* turning when the car does. Decomposing against
  // the old heading and recomposing against the new one silently rotates the
  // whole velocity vector with the car: the lateral component can never
  // accumulate and the cab is permanently on rails, handbrake or not.
  //
  // Authority falls off with speed, so the car turns tightly when parking and
  // sweeps when quick. A stationary car does not turn at all — a cab
  // pirouetting in place reads as broken, and it is the first thing anyone
  // tries.
  const alongOld = fxMul(velocityX, fxCos(heading)) + fxMul(velocityY, fxSin(heading));
  const speed = fxAbs(alongOld);

  let steer = 0;
  if (hasInput(input, Input.Left)) steer -= 1;
  if (hasInput(input, Input.Right)) steer += 1;

  let newHeading = heading;
  if (steer !== 0 && speed > CarTuning.restSpeed) {
    // rate = steerRate * speed / (speed + falloff): near-full authority well
    // above the falloff constant, and zero at rest.
    const authority = fxDiv(speed, speed + CarTuning.steerFalloffSpeed);
    const rate = fxMul(CarTuning.steerRate, authority) >> 16;
    // Reversing steers the other way, as it does in a real car.
    const direction = alongOld < 0 ? -steer : steer;
    newHeading = (heading + direction * rate) & 0xffff;
  }

  const cos = fxCos(newHeading);
  const sin = fxSin(newHeading);

  // --- decompose against the NEW heading -----------------------------------
  //
  // Dot products with the heading and its perpendicular. The operands are
  // velocities (well under one unit per tick), never positions, so fxMul is
  // three orders of magnitude inside the ±181 arithmetic bound (ADR 0003).
  let forward = fxMul(velocityX, cos) + fxMul(velocityY, sin);
  let lateral = fxMul(velocityY, cos) - fxMul(velocityX, sin);

  // --- longitudinal --------------------------------------------------------

  if (hasInput(input, Input.Throttle)) {
    forward += CarTuning.acceleration;
  }
  if (hasInput(input, Input.Brake)) {
    // Braking while moving forward slows; braking at rest backs up. One button
    // doing both is standard for arcade driving and saves a control.
    forward -= forward > CarTuning.restSpeed ? CarTuning.braking : CarTuning.reverse;
  }

  forward = fxMul(forward, CarTuning.drag);

  // --- lateral slide: the drift --------------------------------------------

  const slide = hasInput(input, Input.Handbrake)
    ? CarTuning.handbrakeSlide
    : CarTuning.lateralSlide;
  lateral = fxMul(lateral, slide);

  // --- clamps --------------------------------------------------------------

  if (forward > CarTuning.maxSpeed) forward = CarTuning.maxSpeed;
  if (forward < -CarTuning.maxReverseSpeed) forward = -CarTuning.maxReverseSpeed;

  // Snap to rest rather than letting a truncating multiply leave the car
  // creeping forever at one unit per tick.
  if (fxAbs(forward) < CarTuning.restSpeed) forward = 0;
  if (fxAbs(lateral) < CarTuning.restSpeed) lateral = 0;

  // --- recompose and integrate ---------------------------------------------

  const nextVelocityX = fxMul(forward, cos) - fxMul(lateral, sin);
  const nextVelocityY = fxMul(forward, sin) + fxMul(lateral, cos);

  setCar(world, slot, Car.Heading, newHeading);
  setCar(world, slot, Car.VelocityX, nextVelocityX);
  setCar(world, slot, Car.VelocityY, nextVelocityY);

  // Position is a plain addition. It is never an operand of fxMul — at ±2048 it
  // is an order of magnitude past the squarable bound (ADR 0003).
  setCar(world, slot, Car.X, clampToWorld(getCar(world, slot, Car.X) + nextVelocityX));
  setCar(world, slot, Car.Y, clampToWorld(getCar(world, slot, Car.Y) + nextVelocityY));

  const flags = getCar(world, slot, Car.Flags) & ~CarFlags.Drifting;
  setCar(
    world,
    slot,
    Car.Flags,
    fxAbs(lateral) > DRIFT_THRESHOLD ? flags | CarFlags.Drifting : flags,
  );
}

/** Keep a coordinate inside the world. `S-07` replaces this with real collision. */
function clampToWorld(coordinate: number): number {
  const min = fxFromInt(WORLD_MIN);
  const max = fxFromInt(WORLD_MAX);
  if (coordinate < min) return min;
  if (coordinate > max) return max;
  return coordinate;
}

/**
 * Direction of travel as a `uint16` turn — distinct from {@link Car.Heading}
 * whenever the car is sliding. `C-04` uses the gap between them to angle the
 * tyre marks, and `S-07` uses it for the swept collision test.
 */
export function carVelocityAngle(world: World, slot: number): number {
  return fxAtan2(getCar(world, slot, Car.VelocityY), getCar(world, slot, Car.VelocityX));
}

/** Speed along the direction of travel, in units per tick. Always non-negative. */
export function carSpeed(world: World, slot: number): number {
  const vx = getCar(world, slot, Car.VelocityX);
  const vy = getCar(world, slot, Car.VelocityY);
  // Both are small (well under one unit per tick), so squaring them is inside
  // the ±181 arithmetic bound with three orders of magnitude to spare.
  return fxSqrt(fxMul(vx, vx) + fxMul(vy, vy));
}

/** Speed as a fraction of {@link CarTuning.maxSpeed}, in 16.16, clamped to [0, 1]. */
export function carSpeedFraction(world: World, slot: number): number {
  const fraction = fxDiv(carSpeed(world, slot), CarTuning.maxSpeed);
  if (fraction < 0) return 0;
  return fraction > FX_ONE ? FX_ONE : fraction;
}
