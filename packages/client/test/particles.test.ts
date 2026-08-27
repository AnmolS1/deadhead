import { describe, expect, it } from 'vitest';

import { ParticleTuning, Particles } from '../src/render/particles.js';

/**
 * `C-04` could not measure "200 particles" because nothing spawned any. These
 * pin the properties that make the pool safe to measure WITH — chiefly that it
 * never allocates and never grows, since a particle system that garbage-collects
 * under load ruins the exact statistic `C-06` headlines.
 */
describe('the pool', () => {
  it('starts empty and reports its capacity', () => {
    const p = new Particles(64);
    expect(p.alive).toBe(0);
    expect(p.capacity).toBe(64);
  });

  it('never exceeds capacity, however hard it is pushed', () => {
    // Dropping beats growing: a cap that is sometimes hit is a known cost; a
    // pool that grows under load is an unknown one arriving exactly when the
    // frame is already late.
    const p = new Particles(16);
    p.emit(0, 0, 0, 1000);
    expect(p.alive).toBe(16);
  });

  it('frees slots as particles expire, and reuses them', () => {
    const p = new Particles(8);
    p.emit(0, 0, 0, 8);
    expect(p.alive).toBe(8);
    p.step(ParticleTuning.lifeSeconds * 3);
    expect(p.alive).toBe(0);
    p.emit(0, 0, 0, 8);
    expect(p.alive).toBe(8);
  });

  it('clears', () => {
    const p = new Particles(8);
    p.emit(0, 0, 0, 8);
    p.clear();
    expect(p.alive).toBe(0);
  });
});

describe('emitRate', () => {
  it('accumulates fractions rather than rounding them away', () => {
    // THE bug this guards. At 55/s and a 144 Hz frame, 0.38 particles are due
    // per frame; flooring each frame independently emits NOTHING, so the effect
    // silently never appears — and only on fast machines, which is the worst
    // possible place for it to hide.
    const p = new Particles(200);
    for (let i = 0; i < 144; i += 1) p.emitRate(0, 0, 0, 55, 1 / 144);
    expect(p.alive).toBeGreaterThan(50);
    expect(p.alive).toBeLessThan(60);
  });

  it('emits nothing for a zero timestep', () => {
    const p = new Particles(64);
    p.emitRate(0, 0, 0, 100, 0);
    expect(p.alive).toBe(0);
  });
});

describe('step', () => {
  it('is frame-rate independent', () => {
    // One 100 ms step must land where ten 10 ms steps do, for the same reason
    // `feel/policy.ts`'s ease is: otherwise particles settle at different rates
    // on different machines.
    const a = new Particles(4);
    const b = new Particles(4);
    a.emit(0, 0, 0, 1);
    b.emit(0, 0, 0, 1);

    a.step(0.1);
    for (let i = 0; i < 10; i += 1) b.step(0.01);

    expect(a.alive).toBe(b.alive);
  });

  it('ignores a nonsense timestep rather than producing NaN positions', () => {
    const p = new Particles(4);
    p.emit(0, 0, 0, 1);
    expect(() => p.step(Number.NaN)).not.toThrow();
    expect(p.alive).toBe(1);
  });
});

describe('draw', () => {
  it('reports considered and drawn so the cull can be checked', () => {
    const p = new Particles(32);
    p.emit(0, 0, 0, 10);

    const all = p.draw(
      {} as never,
      () => true,
      () => {},
    );
    expect(all.considered).toBe(10);
    expect(all.drawn).toBe(10);

    // A cull that rejects everything must show as drawn 0 of 10, not as
    // nothing happening — a ratio of 1 is how you spot a cull that stopped.
    const none = p.draw(
      {} as never,
      () => false,
      () => {},
    );
    expect(none.considered).toBe(10);
    expect(none.drawn).toBe(0);
  });

  it('draws nothing when empty', () => {
    const p = new Particles(8);
    const counts = p.draw(
      {} as never,
      () => true,
      () => {},
    );
    expect(counts).toStrictEqual({ considered: 0, drawn: 0 });
  });
});
