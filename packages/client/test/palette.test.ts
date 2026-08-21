import { describe, expect, it } from 'vitest';

// Vite's `?raw` rather than `node:fs`: this package is a browser bundle and
// declares no node types. The source text is the subject here — the accent rule
// is a fact about where a colour is *written*, which no runtime check can see.
import cityText from '../src/render/city.ts?raw';
import figuresText from '../src/render/figures.ts?raw';
import paperText from '../src/render/paper.ts?raw';

import { FOLD_DEPTH, Ink, LIGHT } from '../src/render/palette.js';
import { SHADOW_X, SHADOW_Y } from '../src/render/paper.js';

/** Composite `fg` at `alpha` over `bg`, the way a canvas would. */
function over(fg: string, alpha: number, bg: string): string {
  const parse = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const f = parse(fg);
  const b = parse(bg);
  return (
    '#' +
    [0, 1, 2]
      .map((i) => Math.round(alpha * f[i]! + (1 - alpha) * b[i]!))
      .map((v) => v.toString(16).padStart(2, '0').toUpperCase())
      .join('')
  );
}

describe('the baked tones are what they claim to be', () => {
  // Each of these is documented in palette.ts as a ponderance token composited
  // over another. The comment is only worth having if it is true, and a colour
  // that has drifted from its stated derivation is exactly the kind of thing
  // nobody notices — it still looks fine, it is just no longer the palette.

  it('roadSurface is crease at 10% over paper', () => {
    expect(Ink.roadSurface).toBe(over(Ink.crease, 0.1, Ink.paper));
  });

  it('foldShade is crease at 16% over paperLit', () => {
    expect(Ink.foldShade).toBe(over(Ink.crease, 0.16, Ink.paperLit));
  });

  it('foldShadow is crease at 30% over paper', () => {
    expect(Ink.foldShadow).toBe(over(Ink.crease, 0.3, Ink.paper));
  });

  it('bakes them to solids, because these layers overlap themselves', () => {
    // Roads cross. Drawn with alpha, every junction comes out a shade darker
    // than the two streets meeting there — a crossroads a different colour from
    // its own roads, which is the kind of wrong nobody can name but everybody
    // sees. Solid means overlapping changes nothing.
    for (const tone of [Ink.roadSurface, Ink.foldShade, Ink.foldShadow]) {
      expect(tone, tone).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

describe('the accent is spent exactly where ADR 0001 says', () => {
  // "Monochrome plus ONE accent, reserved for motion and the empty-cab state."
  // That rule is the mitigation for the risk the ADR also names — folded paper
  // reads gentle, and this game is not gentle. It only works while the accent
  // stays scarce, and scarcity is not something a palette file can enforce on
  // its own.
  /** The body of one exported function, comments and all. */
  const body = (source: string, name: string): string => {
    const start = source.indexOf(`export function ${name}(`);
    expect(start, `no function ${name}`).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const next = rest.slice(1).search(/\nexport (function|const)/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  /** Uses of the accent in code. */
  const accentUses = (text: string): number => (text.match(/Ink\.crane(Dark)?\b/g) ?? []).length;

  it('never appears in the static city', () => {
    // Paper, streets, buildings, shadows: all monochrome. The moment the accent
    // leaks into the scenery it stops meaning "you".
    expect(cityText).not.toMatch(/Ink\.crane/);
    expect(paperText).not.toMatch(/Ink\.crane/);
  });

  it('is used by the cab and by the motion scrap, and by nothing else', () => {
    // Counting occurrences would be brittle — a doc comment mentioning the
    // colour would fail it. What matters is WHICH functions reach for it.
    expect(accentUses(body(figuresText, 'cab'))).toBeGreaterThan(0);
    expect(accentUses(body(figuresText, 'scrap'))).toBeGreaterThan(0);

    for (const other of ['passenger', 'destination', 'landmark']) {
      expect(accentUses(body(figuresText, other)), other).toBe(0);
    }
  });

  it('is not what tells a Rush fare from a Meter one', () => {
    // The obvious way to distinguish them would spend the accent a second time.
    // Form and value instead — same folded figure, different posture and ink.
    const passengerBody = body(figuresText, 'passenger');
    expect(accentUses(passengerBody)).toBe(0);
    expect(passengerBody).toContain('rush');
  });
});

describe('one light, for the whole city', () => {
  it('is a unit vector, so the shadow length is FOLD_DEPTH', () => {
    expect(Math.hypot(LIGHT.x, LIGHT.y)).toBeCloseTo(1, 3);
    expect(Math.hypot(SHADOW_X, SHADOW_Y)).toBeCloseTo(FOLD_DEPTH, 3);
  });

  it('derives the shadow offset once, rather than at each call site', () => {
    // The constraint that makes a screen of separate buildings read as one
    // sheet in relief. It is also the thing most likely to be broken by
    // accident later — an offset written by hand somewhere, a light that
    // follows the camera because it looked better in one screenshot.
    expect(SHADOW_X).toBeCloseTo(LIGHT.x * FOLD_DEPTH, 6);
    expect(SHADOW_Y).toBeCloseTo(LIGHT.y * FOLD_DEPTH, 6);
  });

  it('points down and to the right, as paper is lit in every photograph of paper', () => {
    expect(LIGHT.x).toBeGreaterThan(0);
    expect(LIGHT.y).toBeGreaterThan(0);
  });
});
