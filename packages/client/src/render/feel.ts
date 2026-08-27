/**
 * `render/feel.ts` — `C-08`'s screen-space pass, drawn over the scene.
 *
 * Three things, in order: the accent wash, the fold, and the terminal state.
 * Every number comes from `feel/policy.ts`; this file only turns them into
 * shapes.
 *
 * **Screen space, not world space.** The camera keeps the cab centred, so a
 * fold measured from the viewport edges takes the player's *periphery* first
 * and never the ground under them. That is `D-04`'s "loss of information rather
 * than loss of space" — a veteran drives the folded-away streets from memory,
 * a new player cannot. The city underneath is untouched: `S-07` collision does
 * not know this file exists, and passengers out there still spawn and are
 * simply invisible.
 *
 * **No gradients.** `render/paper.ts` says it outright — "a fold is a hard
 * discontinuity; a gradient is what paper does not do" — so the vignette the
 * brief asks for is done as paper closing in, with hard edges and a shaded
 * underside, rather than as a soft radial darkening that would be the one
 * un-paper thing in the game.
 */
import { tuningBanner } from '../debug/playtest-tuning.js';
import { type Feel, FeelTuning, ease } from '../feel/policy.js';

import { Ink } from './palette.js';
import { type PaperContext } from './paper.js';

/**
 * The subset of a 2D context this pass needs, beyond `PaperContext`.
 *
 * `fillText`/`font` are widened HERE rather than on `PaperContext`, because
 * `PaperContext` describes the *art* — and `paper.ts` is explicit that the art
 * has rules (no gradients, no patterns). A clock is printed on top of the
 * picture, not part of it. Nothing that draws the world gains text by this.
 */
export interface FeelContext extends PaperContext {
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillText(text: string, x: number, y: number): void;
}

/** Viewport, in device pixels. */
export interface FeelViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * Eased state that must persist between frames.
 *
 * Kept by the caller rather than in module scope so two canvases — the game and
 * `W-02`'s editor — cannot fight over one wash value.
 */
export interface FeelMemory {
  wash: number;
}

export function newFeelMemory(): FeelMemory {
  return { wash: FeelTuning.emptyWash };
}

/**
 * Draw the feel pass.
 *
 * `dtSeconds` is real elapsed wall time, and it is the one place in the
 * renderer that legitimately uses it: this is presentation easing, not
 * simulation. The sim never sees it (hard invariant #2).
 */
export function renderFeel(
  context: FeelContext,
  viewport: FeelViewport,
  feel: Feel,
  memory: FeelMemory,
  dtSeconds: number,
): void {
  memory.wash = ease(memory.wash, feel.wash, FeelTuning.washSeconds, dtSeconds);

  context.save();

  // **Fold first, wash second, and the order is load-bearing.** The folded
  // sheet is the SAME sheet — it must take the same tint as everything under
  // it. Washing first and folding on top leaves the bands untinted, and they
  // then read as cold holes punched in the picture rather than as paper
  // turning over. That is exactly how this looked before someone rendered it
  // and compared the two states side by side.
  drawFold(context, viewport, feel);
  drawWash(context, viewport, memory.wash);

  // **After the wash, deliberately.** The fold is the sheet and takes the tint;
  // the clock is printed on top of the picture and must stay legible, because
  // an unreadable clock is the thing this element exists to fix.
  drawClock(context, viewport, feel);

  if (feel.ended) drawEnded(context, viewport);

  // Last of all, over even the terminal state. A modified build must announce
  // itself no matter what else is on screen — a tester playing at `?speed=1.4`
  // without knowing it is worse than no test, and a tester the OPERATOR forgot
  // to reset is worse still.
  const banner = tuningBanner();
  if (banner !== null) drawBanner(context, viewport, banner);

  context.restore();
}

/**
 * The accent wash — "colour desaturates toward the accent" while empty.
 *
 * A flat fill of `Ink.crane` at low alpha. Not a `filter: saturate()`: that is
 * expensive per frame, and it is absent from the test double, so it would make
 * this pass unverifiable outside a browser for no visual gain.
 */
function drawWash(context: FeelContext, viewport: FeelViewport, alpha: number): void {
  if (alpha <= 0.001) return;
  context.save();
  context.globalAlpha = alpha;
  context.fillStyle = Ink.crane;
  context.fillRect(0, 0, viewport.width, viewport.height);
  context.restore();
}

/**
 * The fold.
 *
 * Each folded edge is drawn as two shapes: the flat of the folded-over sheet in
 * the paper colour, and a shaded triangle at the crease where the sheet turns.
 * The shade is what makes it read as folded rather than as a blank border —
 * without it the effect looks like the canvas is simply smaller.
 */
function drawFold(context: FeelContext, viewport: FeelViewport, feel: Feel): void {
  const { width: w, height: h } = viewport;
  const { top, right, bottom, left } = feel.insets;

  const bands: readonly (readonly [number, number, number, number, 'h' | 'v'])[] = [
    [0, 0, w, top * h, 'h'],
    [0, h - bottom * h, w, bottom * h, 'h'],
    [0, 0, left * w, h, 'v'],
    [w - right * w, 0, right * w, h, 'v'],
  ];

  for (const [x, y, bw, bh, axis] of bands) {
    if (bw <= 0.5 || bh <= 0.5) continue;

    // The flat of the fold.
    context.fillStyle = Ink.foldShade;
    context.fillRect(x, y, bw, bh);

    // The crease itself: a hard line where the sheet turns over. This is the
    // whole reason the fold reads as paper.
    context.fillStyle = Ink.foldShadow;
    const creaseWidth = 2;
    if (axis === 'h') {
      // Top band creases along its bottom edge; bottom band along its top.
      const creaseY = y === 0 ? y + bh - creaseWidth : y;
      context.fillRect(x, creaseY, bw, creaseWidth);
    } else {
      const creaseX = x === 0 ? x + bw - creaseWidth : x;
      context.fillRect(creaseX, y, creaseWidth, bh);
    }
  }

  drawCorners(context, viewport, feel);
}

/**
 * Corner gussets, where two folded edges meet.
 *
 * Without these the corners show a square notch of un-folded scene between the
 * two bands — which reads as a rendering bug rather than as paper, and it is
 * exactly the kind of thing only visible once it is on screen.
 */
function drawCorners(context: FeelContext, viewport: FeelViewport, feel: Feel): void {
  const { width: w, height: h } = viewport;
  const t = feel.insets.top * h;
  const b = feel.insets.bottom * h;
  const l = feel.insets.left * w;
  const r = feel.insets.right * w;

  context.fillStyle = Ink.foldShadow;
  const corners: readonly (readonly [number, number, number, number])[] = [
    [0, 0, l, t],
    [w - r, 0, r, t],
    [0, h - b, l, b],
    [w - r, h - b, r, b],
  ];
  for (const [x, y, cw, ch] of corners) {
    if (cw <= 0.5 || ch <= 0.5) continue;
    // A diagonal, so the corner reads as two sheets meeting at a mitre rather
    // than as a solid block.
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + cw, y);
    context.lineTo(x, y + ch);
    context.closePath();
    context.fill();
  }
}

/**
 * The deadhead clock.
 *
 * Added after the first playtest: the fold conveys urgency without conveying
 * magnitude, and pressure you cannot size reads as stress rather than as a
 * deadline. §7.5 always permitted this — "a numeric clock stays available
 * somewhere, but the fold is what a player actually reads" — so it is sized and
 * placed to stay subordinate to the fold rather than to compete with it.
 *
 * **It rides the fold inward.** Positioned relative to the folded insets, so the
 * closing field carries it rather than occluding it — and so the two clocks
 * (the fold and the number) visibly belong to each other.
 *
 * **It dims while a passenger is aboard**, because the bank is frozen then. A
 * visibly stopped number is the least ambiguous statement of `C-08`'s pass
 * condition there is: "the timer stops when someone's in the car" is precisely
 * what a held clock says, without a word of instruction.
 */
function drawClock(context: FeelContext, viewport: FeelViewport, feel: Feel): void {
  const { width: w, height: h } = viewport;
  const size = Math.max(11, Math.round(h * 0.022));

  context.save();
  // A system stack: `no-thirdparty.sh` forbids a CDN font, and nothing is
  // self-hosted for the canvas yet. `P-01` can align this with the site's
  // `var(--font-*)` when the game gets a real page.
  context.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textAlign = 'right';
  context.textBaseline = 'top';

  // Held = frozen bank = passenger aboard. Dimmer, not hidden: hiding it would
  // remove the very comparison that teaches the mechanic.
  context.globalAlpha = feel.clockHeld ? 0.34 : 0.72;
  context.fillStyle = Ink.graphite;

  const pad = Math.round(size * 0.9);
  context.fillText(feel.clock, w - feel.insets.right * w - pad, feel.insets.top * h + pad);
  context.restore();
}

/**
 * The terminal state.
 *
 * **This exists because without it a run does not visibly end.** `stepClocks`
 * sets `CarFlags.Eliminated` at bank zero and `scene.ts:182` then stops drawing
 * the cab — so the run finishes by the player's car silently vanishing while
 * the camera keeps following nothing. A playtester reads that as a crash, and
 * their feedback is then about the crash rather than about the feel pass.
 *
 * Deliberately minimal: `G-01` owns the real end-of-run (score, restart,
 * submission). This is the floor — the sheet closes and the world goes quiet,
 * which is `D-04`'s "the clock running out and the map going dark become the
 * same event" taken literally.
 */
function drawEnded(context: FeelContext, viewport: FeelViewport): void {
  context.save();
  context.globalAlpha = 0.82;
  context.fillStyle = Ink.foldShade;
  context.fillRect(0, 0, viewport.width, viewport.height);

  context.globalAlpha = 1;
  context.fillStyle = Ink.graphite;
  const barHeight = Math.max(2, Math.round(viewport.height * 0.004));
  const barWidth = Math.round(viewport.width * 0.16);
  context.fillRect(
    Math.round((viewport.width - barWidth) / 2),
    Math.round(viewport.height / 2 - barHeight / 2),
    barWidth,
    barHeight,
  );
  context.restore();
}

/**
 * The "this build is not stock" banner.
 *
 * Deliberately in the accent and deliberately ugly. It is not chrome to be
 * lived with — it is a warning that the numbers under this session are not the
 * numbers in the repository, and it should be slightly annoying so nobody
 * forgets it is on.
 */
function drawBanner(context: FeelContext, viewport: FeelViewport, text: string): void {
  const size = Math.max(10, Math.round(viewport.height * 0.017));
  context.save();
  context.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.globalAlpha = 0.9;
  context.fillStyle = Ink.crane;
  context.fillText(text, Math.round(viewport.width / 2), Math.round(size * 0.6));
  context.restore();
}
