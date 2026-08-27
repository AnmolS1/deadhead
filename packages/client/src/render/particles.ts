/**
 * `render/particles.ts` — torn scraps of the sheet, thrown off by motion.
 *
 * **Client-side, and that is a correctness requirement rather than a
 * convenience.** Particles are presentation: they are never hashed, never sent,
 * and never read by `step()`. Putting them in the sim would add state that must
 * be byte-identical across three engines (hard invariant #1) to buy nothing —
 * two players seeing slightly different dust is not a desync, it is two
 * renderers.
 *
 * That is also why this file may use `Math.random()` and wall-clock time, both
 * of which are banned inside `packages/sim`. Nothing here reaches the sim.
 *
 * `scene.ts` has always listed a `particles` layer and marked it `(C-08)`;
 * `figures.ts` has always been able to draw one. Nothing ever spawned any,
 * which is why `C-04`'s *"60 fps with 12 cars, 40 NPCs and 200 particles"*
 * could not be measured — a third of the load did not exist.
 */
import { scrap } from './figures.js';
import { type PaperContext } from './paper.js';

export const ParticleTuning = {
  /** Hard cap. The pool is fixed-size, so this is also the allocation. */
  max: 400,
  /** Lifetime, in seconds. */
  lifeSeconds: 0.65,
  /** Scraps per second while drifting. */
  driftRate: 55,
  /** Scraps emitted in one burst on a delivery. */
  deliveryBurst: 24,
  /** World units per second a scrap drifts, before slowdown. */
  speed: 7,
  /** Fraction of velocity surviving each second — makes them settle, not fly. */
  drag: 0.02,
  /** Size in world units. */
  size: 0.42,
} as const;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds remaining. Zero or below means the slot is free. */
  life: number;
  spin: number;
  angle: number;
}

/**
 * A fixed-size pool.
 *
 * **Never allocates after construction.** A particle system that allocates per
 * emit is a garbage generator, and GC pauses show up in exactly the statistic
 * `C-06` headlines — the 1% low. The whole point of this file is to be measured
 * without being the thing that ruins the measurement.
 */
export class Particles {
  readonly #pool: Particle[];
  #alive = 0;
  /** Carried between frames so a fractional emit rate still emits. */
  #pending = 0;

  constructor(capacity: number = ParticleTuning.max) {
    this.#pool = Array.from({ length: capacity }, () => ({
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
      spin: 0,
      angle: 0,
    }));
  }

  get alive(): number {
    return this.#alive;
  }

  get capacity(): number {
    return this.#pool.length;
  }

  /** Free every particle. For tests and for a run restart. */
  clear(): void {
    for (const p of this.#pool) p.life = 0;
    this.#alive = 0;
    this.#pending = 0;
  }

  /**
   * Emit `count` scraps at a point, thrown roughly opposite the given heading.
   *
   * Silently drops the excess when the pool is full. **Dropping beats growing**:
   * a cap that is sometimes hit is a known cost, and a pool that grows under
   * load is an unknown one that arrives exactly when the frame is already late.
   */
  emit(x: number, y: number, headingRadians: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
      const slot = this.#free();
      if (slot === null) return;

      // Opposite the direction of travel, in a spray.
      const spread = (Math.random() - 0.5) * 1.7;
      const away = headingRadians + Math.PI + spread;
      const speed = ParticleTuning.speed * (0.45 + Math.random() * 0.9);

      slot.x = x;
      slot.y = y;
      slot.vx = Math.cos(away) * speed;
      slot.vy = Math.sin(away) * speed;
      slot.life = ParticleTuning.lifeSeconds * (0.65 + Math.random() * 0.7);
      slot.angle = Math.random() * Math.PI * 2;
      slot.spin = (Math.random() - 0.5) * 9;
      this.#alive += 1;
    }
  }

  /**
   * Emit at a rate, accumulating fractions across frames.
   *
   * Without the accumulator a rate below one-per-frame rounds to zero and the
   * effect silently never appears at high frame rates — the opposite of the
   * intended behaviour, and invisible on the machine you developed it on.
   */
  emitRate(x: number, y: number, headingRadians: number, perSecond: number, dt: number): void {
    this.#pending += perSecond * dt;
    const whole = Math.floor(this.#pending);
    if (whole <= 0) return;
    this.#pending -= whole;
    this.emit(x, y, headingRadians, whole);
  }

  /** Advance every live particle. `dt` is real seconds — presentation, not sim. */
  step(dt: number): void {
    if (!(dt > 0)) return;
    // Frame-rate independent decay, for the same reason `feel/policy.ts`'s ease
    // is: a per-frame multiply makes particles settle at different rates on
    // different machines.
    const keep = ParticleTuning.drag ** dt;
    for (const p of this.#pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.#alive -= 1;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= keep;
      p.vy *= keep;
      p.angle += p.spin * dt;
    }
  }

  /**
   * Draw every live particle, in world space.
   *
   * `visible` culls against the same bounds the rest of the scene uses; the
   * count returned is what `C-06` reports, so a cull that stopped working shows
   * up as a ratio of 1 rather than as a mystery.
   */
  draw(
    context: PaperContext,
    visible: (x: number, y: number) => boolean,
    posed: (x: number, y: number, angle: number, paint: () => void) => void,
  ): { considered: number; drawn: number } {
    let considered = 0;
    let drawn = 0;
    for (const p of this.#pool) {
      if (p.life <= 0) continue;
      considered += 1;
      if (!visible(p.x, p.y)) continue;
      drawn += 1;
      const fade = p.life / ParticleTuning.lifeSeconds;
      posed(p.x, p.y, p.angle, () => scrap(context, ParticleTuning.size * fade, fade));
    }
    return { considered, drawn };
  }

  #free(): Particle | null {
    for (const p of this.#pool) {
      if (p.life <= 0) return p;
    }
    return null;
  }
}
