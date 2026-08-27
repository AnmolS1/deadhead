import { describe, expect, it } from 'vitest';

import { feelFor } from '../src/feel/index.js';
import { newFeelMemory, renderFeel, type FeelContext } from '../src/render/feel.js';
import { Ink } from '../src/render/palette.js';

/**
 * `C-08`'s draw pass. These do not check that it *looks* right — nothing can,
 * outside a browser, and the two real defects in this file were both found by
 * rendering it and comparing two states side by side. What they pin is the
 * ORDER, which is the one thing that was wrong and would silently regress.
 */

interface Call {
  readonly op: string;
  readonly style: string;
  readonly alpha: number;
}

function recorder(): { context: FeelContext; calls: Call[] } {
  const calls: Call[] = [];
  const state = { fillStyle: '' as string, globalAlpha: 1 };
  const stack: { fillStyle: string; globalAlpha: number }[] = [];

  const context = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter' as CanvasLineJoin,
    save() {
      stack.push({ ...state });
    },
    restore() {
      const top = stack.pop();
      if (top) {
        state.fillStyle = top.fillStyle;
        state.globalAlpha = top.globalAlpha;
      }
    },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    setLineDash() {},
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillText(text: string) {
      calls.push({
        op: `fillText:${text}`,
        style: String(state.fillStyle),
        alpha: state.globalAlpha,
      });
    },
    fill() {
      calls.push({ op: 'fill', style: String(state.fillStyle), alpha: state.globalAlpha });
    },
    fillRect() {
      calls.push({ op: 'fillRect', style: String(state.fillStyle), alpha: state.globalAlpha });
    },
  } as unknown as FeelContext;

  return { context, calls };
}

const VIEWPORT = { width: 800, height: 600 };

/** Deep into a run, empty — folds present and the wash on. */
const MID_RUN = feelFor({ carrying: false, deadheadTicks: 600, eliminated: false });

describe('draw order', () => {
  it('draws the fold BEFORE the wash', () => {
    // The defect this pins. The folded sheet is the same sheet, so it must take
    // the same tint. Washing first and folding on top left the bands untinted,
    // and they read as cold holes punched in the picture rather than as paper
    // turning over — obvious on screen, invisible to every other test here.
    const { context, calls } = recorder();
    const memory = newFeelMemory();
    renderFeel(context, VIEWPORT, MID_RUN, memory, 1);

    const firstFold = calls.findIndex((c) => c.style === Ink.foldShade);
    const wash = calls.findIndex((c) => c.style === Ink.crane);

    expect(firstFold).toBeGreaterThanOrEqual(0);
    expect(wash).toBeGreaterThanOrEqual(0);
    expect(firstFold).toBeLessThan(wash);
  });

  it('draws only the clock at the very start of a run', () => {
    // No fold yet and no wash while carrying — but the clock is always present,
    // because a clock that appears partway through a run is a clock nobody
    // learns to look at.
    const { context, calls } = recorder();
    const memory = { wash: 0 };
    const fresh = feelFor({ carrying: true, deadheadTicks: 5400, eliminated: false });
    renderFeel(context, VIEWPORT, fresh, memory, 1);
    expect(calls.map((c) => c.op)).toStrictEqual(['fillText:3:00']);
  });

  it('draws the clock AFTER the wash, so it stays legible', () => {
    // The fold is the sheet and takes the tint; the clock is printed on top.
    // An unreadable clock is the thing this element exists to fix.
    const { context, calls } = recorder();
    renderFeel(context, VIEWPORT, MID_RUN, newFeelMemory(), 1);
    const wash = calls.findIndex((c) => c.style === Ink.crane);
    const clock = calls.findIndex((c) => c.op.startsWith('fillText:'));
    expect(wash).toBeGreaterThanOrEqual(0);
    expect(clock).toBeGreaterThan(wash);
  });

  it('dims the clock while a passenger is aboard', () => {
    const held = feelFor({ carrying: true, deadheadTicks: 600, eliminated: false });
    const free = feelFor({ carrying: false, deadheadTicks: 600, eliminated: false });
    const alphaOf = (feel: typeof held) => {
      const { context, calls } = recorder();
      renderFeel(context, VIEWPORT, feel, { wash: 0 }, 1);
      return calls.find((c) => c.op.startsWith('fillText:'))?.alpha ?? -1;
    };
    // A frozen number IS the pass condition, shown rather than said — so it is
    // dimmed, never hidden. Hiding it removes the comparison that teaches it.
    expect(alphaOf(held)).toBeGreaterThan(0);
    expect(alphaOf(held)).toBeLessThan(alphaOf(free));
  });
});

describe('the wash', () => {
  it('is skipped entirely once it has eased to zero', () => {
    const { context, calls } = recorder();
    const memory = { wash: 0 };
    const carrying = feelFor({ carrying: true, deadheadTicks: 600, eliminated: false });
    renderFeel(context, VIEWPORT, carrying, memory, 1);
    expect(calls.some((c) => c.style === Ink.crane)).toBe(false);
  });

  it('eases rather than snapping when the state flips', () => {
    const memory = newFeelMemory();
    const before = memory.wash;
    const carrying = feelFor({ carrying: true, deadheadTicks: 600, eliminated: false });
    renderFeel(recorder().context, VIEWPORT, carrying, memory, 1 / 60);
    // One frame must move it, but nowhere near all the way — a pickup is a
    // half-second bloom of colour, not an instant snap.
    expect(memory.wash).toBeLessThan(before);
    expect(memory.wash).toBeGreaterThan(0);
  });
});

describe('the terminal state', () => {
  it('paints over everything when the run has ended', () => {
    // Without this a run ends by the cab silently vanishing (scene.ts:182) and
    // a playtester reports a crash instead of a feeling.
    const { context, calls } = recorder();
    const ended = feelFor({ carrying: false, deadheadTicks: 0, eliminated: true });
    renderFeel(context, VIEWPORT, ended, newFeelMemory(), 1);

    expect(calls.some((c) => c.op === 'fillRect' && c.style === Ink.graphite)).toBe(true);
    const last = calls[calls.length - 1];
    expect(last?.op).toBe('fillRect');
    expect(last?.style).toBe(Ink.graphite);
  });

  it('does not paint it while the cab is still driving', () => {
    // Checks for the graphite BAR (a fillRect), not for graphite generally —
    // the clock is graphite too, and a test that cannot tell them apart would
    // pass whether or not the terminal state was drawn.
    const { context, calls } = recorder();
    renderFeel(context, VIEWPORT, MID_RUN, newFeelMemory(), 1);
    expect(calls.some((c) => c.op === 'fillRect' && c.style === Ink.graphite)).toBe(false);
    // ...and the clock IS present, so the assertion above is discriminating
    // rather than passing because nothing was drawn at all.
    expect(calls.some((c) => c.op.startsWith('fillText:'))).toBe(true);
  });
});
