import { describe, expect, it } from 'vitest';

import { MinimapTuning, renderMinimap, type MinimapContext } from '../src/render/minimap.js';
import { Ink } from '../src/render/palette.js';

/**
 * `W-06`. The minimap exists because City 01 has **19 destinations drawn
 * identically** — the target was never hidden, it was indistinguishable from
 * eighteen decoys. These pin the parts that decide whether it answers "which
 * one" and "which way"; whether it *looks* right was checked by rendering it.
 */
interface Call {
  readonly op: string;
  readonly style: string;
  readonly x: number;
  readonly y: number;
}

function recorder(): { context: MinimapContext; calls: Call[] } {
  const calls: Call[] = [];
  const state = { fillStyle: '', strokeStyle: '', globalAlpha: 1 };
  const stack: (typeof state)[] = [];
  const context = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    lineWidth: 1,
    lineJoin: 'miter' as CanvasLineJoin,
    save() {
      stack.push({ ...state });
    },
    restore() {
      const t = stack.pop();
      if (t) Object.assign(state, t);
    },
    beginPath() {},
    closePath() {},
    stroke() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    setLineDash() {},
    fillRect(x: number, y: number) {
      calls.push({ op: 'fillRect', style: String(state.fillStyle), x, y });
    },
  } as unknown as MinimapContext;
  return { context, calls };
}

const VIEWPORT = { width: 1000, height: 800 };
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

function base(destination: { x: number; y: number } | null) {
  return {
    eye: { x: 0, y: 0 },
    edges: [{ a: { x: -50, y: 0 }, b: { x: 50, y: 0 } }],
    landmarks: [{ x: 20, y: 20 }],
    destination,
    insets: NO_INSETS,
  };
}

/** Every marker drawn in the accent — i.e. the destination and nothing else. */
function accentMarks(calls: Call[]): Call[] {
  return calls.filter((c) => c.style === Ink.crane);
}

describe('the destination marker', () => {
  it('is absent when the cab is empty', () => {
    // No fare, no target. A map that always shows a destination would be
    // pointing at someone else's.
    const { context, calls } = recorder();
    renderMinimap(context, VIEWPORT, base(null));
    expect(accentMarks(calls)).toHaveLength(0);
  });

  it('appears when carrying', () => {
    const { context, calls } = recorder();
    renderMinimap(context, VIEWPORT, base({ x: 40, y: 40 }));
    expect(accentMarks(calls)).toHaveLength(1);
  });

  it('is the ONLY thing drawn in the accent', () => {
    // The accent is the game's loudest ink. If a landmark or the cab shared it,
    // the map would have two things claiming to be the answer.
    const { context, calls } = recorder();
    renderMinimap(context, VIEWPORT, base({ x: 40, y: 40 }));
    expect(accentMarks(calls)).toHaveLength(1);
    expect(calls.filter((c) => c.style === Ink.graphite).length).toBeGreaterThan(0);
  });
});

describe('a destination beyond the window', () => {
  const FAR = MinimapTuning.windowUnits * 10;

  it('is clamped to the rim rather than dropped', () => {
    // THE thing that makes the map answer "which way". Dropping it would leave
    // a carrying player with a blank map and no idea the fare was off-screen.
    const { context, calls } = recorder();
    renderMinimap(context, VIEWPORT, base({ x: FAR, y: 0 }));
    expect(accentMarks(calls)).toHaveLength(1);
  });

  it('keeps the rim marker inside the map, however far away the fare is', () => {
    const side = Math.max(
      MinimapTuning.minSizePx,
      Math.round(Math.min(VIEWPORT.width, VIEWPORT.height) * MinimapTuning.sizeFraction),
    );
    const left = MinimapTuning.padPx;
    const top = VIEWPORT.height - MinimapTuning.padPx - side;

    for (const dest of [
      { x: FAR, y: 0 },
      { x: -FAR, y: 0 },
      { x: 0, y: FAR },
      { x: 0, y: -FAR },
      { x: FAR, y: FAR },
      { x: -FAR, y: -FAR },
    ]) {
      const { context, calls } = recorder();
      renderMinimap(context, VIEWPORT, base(dest));
      const mark = accentMarks(calls)[0];
      expect(mark).toBeDefined();
      // A marker escaping the map would draw over the world — worse than none.
      expect(mark!.x).toBeGreaterThanOrEqual(left - 1);
      expect(mark!.x).toBeLessThanOrEqual(left + side + 1);
      expect(mark!.y).toBeGreaterThanOrEqual(top - 1);
      expect(mark!.y).toBeLessThanOrEqual(top + side + 1);
    }
  });

  it('points the right way — direction survives the clamp', () => {
    const centreOf = (dest: { x: number; y: number }): Call => {
      const { context, calls } = recorder();
      renderMinimap(context, VIEWPORT, base(dest));
      return accentMarks(calls)[0]!;
    };
    // East of the cab must land right of where west lands, and south below north.
    expect(centreOf({ x: FAR, y: 0 }).x).toBeGreaterThan(centreOf({ x: -FAR, y: 0 }).x);
    expect(centreOf({ x: 0, y: FAR }).y).toBeGreaterThan(centreOf({ x: 0, y: -FAR }).y);
  });
});

describe('placement', () => {
  it('rides the fold inward rather than being eaten by it', () => {
    // `C-08`'s fold closes the field from the edges. A map pinned to the raw
    // viewport corner would disappear under it late in a run — exactly when
    // knowing where you are matters most.
    const { context: c1, calls: flat } = recorder();
    renderMinimap(c1, VIEWPORT, base({ x: 10, y: 10 }));

    const { context: c2, calls: folded } = recorder();
    renderMinimap(c2, VIEWPORT, {
      ...base({ x: 10, y: 10 }),
      insets: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
    });

    const cab = (calls: Call[]): Call => calls.filter((c) => c.style === Ink.graphite)[0]!;
    expect(cab(folded).x).toBeGreaterThan(cab(flat).x);
    expect(cab(folded).y).toBeLessThan(cab(flat).y);
  });
});
