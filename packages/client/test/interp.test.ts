import { describe, expect, it } from 'vitest';

import { FX_ONE, QUARTER_TURN, TURN, fxFromInt } from '@deadhead/sim';

import {
  angleToRadians,
  lerp,
  lerpAngle,
  lerpFixed,
  lerpPose,
  separation,
  shouldInterpolate,
} from '../src/render/interp.js';

describe('lerp', () => {
  it('hits both ends exactly', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it('is linear in between', () => {
    expect(lerp(0, 100, 0.25)).toBe(25);
    expect(lerp(-50, 50, 0.5)).toBe(0);
  });
});

describe('lerpFixed', () => {
  it('converts out of 16.16 as it interpolates', () => {
    // The division lives here so a renderer never handles a raw fixed-point
    // number and never has to remember which scale it is in.
    expect(lerpFixed(fxFromInt(10), fxFromInt(20), 0.5)).toBe(15);
    expect(lerpFixed(0, FX_ONE, 0.25)).toBe(0.25);
  });

  it('produces sub-unit positions, which is the point', () => {
    // A cab moves about one unit per tick. If interpolation could only land on
    // whole units it would do nothing at all.
    const a = lerpFixed(0, FX_ONE, 0.1);
    const b = lerpFixed(0, FX_ONE, 0.2);
    expect(b).toBeGreaterThan(a);
    expect(a).not.toBe(0);
  });
});

describe('lerpAngle takes the short way', () => {
  it('interpolates forward through zero', () => {
    // The bug this function exists for. Rotating from 65,000 to 500 is 1,036
    // units forward through zero; a straight lerp treats it as 64,500 backwards
    // and spins the cab almost a full turn the wrong way — once per lap,
    // forever, and only when crossing zero, which is why it survives casual
    // testing.
    const midpoint = lerpAngle(65_000, 500, 0.5);

    // Halfway along the short arc is 65,518, which wraps to 65,518 — still just
    // below zero. Assert it is near one end or the other, never in the middle
    // of the long way round.
    expect(midpoint > 65_000 || midpoint < 500).toBe(true);
    expect(midpoint).toBeGreaterThan(30_000 + 32_768 - TURN);
  });

  it('never travels more than half a turn', () => {
    // The defining property: whatever the pair, the arc walked is the short one.
    //
    // The helper below is not decoration. The first version of this test wrote
    // the wrap as `(x + TURN/2) % TURN - TURN/2`, which is wrong for negative
    // x because JavaScript's `%` keeps the sign — the exact mistake lerpAngle
    // exists to prevent, made in the test that checks it. It reported a 49,493
    // unit arc for a 16,043 unit move.
    const shortestArc = (from: number, to: number): number => {
      let delta = (to - from) % TURN;
      if (delta > TURN / 2) delta -= TURN;
      if (delta < -TURN / 2) delta += TURN;
      return delta;
    };

    for (let from = 0; from < TURN; from += 971) {
      for (let to = 0; to < TURN; to += 1_237) {
        const stepped = lerpAngle(from, to, 0.5);
        // Half of the short arc, because alpha is 0.5.
        const walked = Math.abs(shortestArc(from, stepped));
        const total = Math.abs(shortestArc(from, to));
        expect(walked, `${from} -> ${to}`).toBeLessThanOrEqual(total / 2 + 1);
        expect(walked, `${from} -> ${to}`).toBeLessThanOrEqual(TURN / 4 + 1);
      }
    }
  });

  it('hits both ends exactly', () => {
    for (const [from, to] of [
      [0, 100],
      [65_000, 500],
      [500, 65_000],
      [0, 32_768],
    ] as const) {
      expect(lerpAngle(from, to, 0), `${from}`).toBeCloseTo(from, 6);
      expect(lerpAngle(from, to, 1), `${to}`).toBeCloseTo(to, 6);
    }
  });

  it('always returns an angle inside one turn', () => {
    // A negative intermediate is reachable when interpolating backwards through
    // zero, and an out-of-range angle would index past the end of the trig
    // table if it ever reached the sim's helpers.
    for (let from = 0; from < TURN; from += 617) {
      for (const alpha of [0, 0.13, 0.5, 0.87, 1]) {
        const angle = lerpAngle(from, (from + 40_000) & 0xffff, alpha);
        expect(angle).toBeGreaterThanOrEqual(0);
        expect(angle).toBeLessThan(TURN);
      }
    }
  });

  it('is symmetric — reversing the pair reverses the path', () => {
    const forward = lerpAngle(1_000, 3_000, 0.25);
    const backward = lerpAngle(3_000, 1_000, 0.75);
    expect(forward).toBeCloseTo(backward, 6);
  });

  it('handles the exact half-turn without spinning', () => {
    // Ambiguous by construction — both arcs are the same length. It must pick
    // one and stay on it rather than oscillating.
    const angle = lerpAngle(0, TURN / 2, 0.5);
    expect(angle).toBeGreaterThanOrEqual(0);
    expect(angle).toBeLessThan(TURN);
    expect(lerpAngle(0, TURN / 2, 0.5)).toBe(angle);
  });

  it('masks inputs outside a turn rather than trusting them', () => {
    expect(lerpAngle(TURN + 100, TURN + 200, 0.5)).toBeCloseTo(150, 6);
  });
});

describe('angleToRadians', () => {
  it('maps a turn onto 2π', () => {
    expect(angleToRadians(0)).toBe(0);
    expect(angleToRadians(QUARTER_TURN)).toBeCloseTo(Math.PI / 2, 9);
    expect(angleToRadians(TURN / 2)).toBeCloseTo(Math.PI, 9);
    expect(angleToRadians(TURN)).toBeCloseTo(Math.PI * 2, 9);
  });
});

describe('lerpPose', () => {
  it('interpolates position and heading together', () => {
    const pose = lerpPose(
      { x: 0, y: 0, heading: 65_000 },
      { x: fxFromInt(10), y: fxFromInt(20), heading: 500 },
      0.5,
    );

    expect(pose.x).toBe(5);
    expect(pose.y).toBe(10);
    expect(pose.heading > 65_000 || pose.heading < 500).toBe(true);
  });
});

describe('teleports must not be interpolated', () => {
  it('measures separation in world units', () => {
    expect(separation({ x: 0, y: 0 }, { x: fxFromInt(3), y: fxFromInt(4) })).toBeCloseTo(5, 9);
  });

  it('accepts ordinary movement', () => {
    // A cab covers at most one unit per tick under its own power.
    expect(shouldInterpolate({ x: 0, y: 0 }, { x: fxFromInt(1), y: 0 })).toBe(true);
  });

  it('rejects a jump across the map', () => {
    // A respawn (G-01) or a hard correction (M-06). Sliding a cab across the
    // city over one frame is far more jarring than a snap, so C-04 skips
    // interpolation entirely when this returns false.
    expect(shouldInterpolate({ x: 0, y: 0 }, { x: fxFromInt(400), y: fxFromInt(400) })).toBe(false);
  });

  it('takes the threshold as an argument, because M-06 wants a different one', () => {
    const far = { x: fxFromInt(20), y: 0 };
    expect(shouldInterpolate({ x: 0, y: 0 }, far, 8)).toBe(false);
    expect(shouldInterpolate({ x: 0, y: 0 }, far, 40)).toBe(true);
  });
});
