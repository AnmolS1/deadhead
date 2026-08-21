/**
 * `render/figures.ts` — the folded things that move.
 *
 * A cab and a passenger, both origami: angular, flat-shaded, built from
 * straight folds. No curves anywhere. A rounded car in a city of creased paper
 * is the one shape that would give the whole thing away.
 *
 * ## The cab's colour carries the game's central state
 *
 * ADR 0001 reserves the accent for **motion and the empty-cab state**, and the
 * second half of that is not arbitrary. An empty cab is a cab burning its
 * deadhead clock — the thing the game is named after and the thing you are
 * trying to stop doing. So an empty cab is {@link Ink.crane}, the only
 * saturated colour in the world, and a carrying cab goes quiet in graphite.
 *
 * The result is that the screen is loud when you are losing and calm when you
 * are earning, which is the correct way round and costs nothing to render.
 * `DESIGN.md` §2.1 calls the empty/carrying contrast the whole game; this is
 * that contrast, in one channel a player reads without looking.
 *
 * ## Rush passengers are told apart by value, not by hue
 *
 * A Rush fare has to be distinguishable at a glance, and the obvious answer —
 * give it its own colour — would spend the accent a second time and break the
 * palette rule the identity rests on. So Meter and Rush differ in **form and
 * value** instead: same folded figure, different posture and a lighter ink.
 * Everything in this game that is not motion is distinguished that way.
 */
import { CAB, Ink } from './palette.js';
import type { PaperContext } from './paper.js';

/** Draws a shape already translated and rotated into place. */
type Shaper = (context: PaperContext) => void;

/**
 * Run `draw` with the canvas moved to a pose.
 *
 * Every figure is authored pointing along +x at the origin, which keeps the
 * vertex lists readable — the alternative is trigonometry at every call site
 * and shapes nobody can picture from the source.
 */
export function posed(
  context: PaperContext & {
    translate(x: number, y: number): void;
    rotate(angle: number): void;
  },
  x: number,
  y: number,
  radians: number,
  draw: Shaper,
): void {
  context.save();
  context.translate(x, y);
  context.rotate(radians);
  draw(context);
  context.restore();
}

/**
 * The cab: a folded paper car.
 *
 * Six vertices — a blunt nose, a wide tail, and a fold running the length of
 * the roof. The fold is the whole silhouette: it splits the body into a lit
 * side and a shadowed one, so the cab reads as a folded object at any angle
 * rather than as a coloured rectangle.
 */
export function cab(context: PaperContext, carrying: boolean): void {
  const l = CAB.halfLength;
  const w = CAB.halfWidth;

  const body = Ink.crane;
  const bodyShadow = Ink.craneDark;
  const quiet = Ink.graphite;
  const quietShadow = 'rgba(27, 42, 51, 0.72)';

  // Empty is loud, carrying is quiet. See the note at the top of this file.
  const lit = carrying ? quiet : body;
  const shade = carrying ? quietShadow : bodyShadow;

  // Lit half — the side of the roof turned toward the light.
  context.fillStyle = lit;
  context.beginPath();
  context.moveTo(l, 0);
  context.lineTo(l * 0.35, -w);
  context.lineTo(-l, -w * 0.85);
  context.lineTo(-l, 0);
  context.closePath();
  context.fill();

  // Shadowed half.
  context.fillStyle = shade;
  context.beginPath();
  context.moveTo(l, 0);
  context.lineTo(l * 0.35, w);
  context.lineTo(-l, w * 0.85);
  context.lineTo(-l, 0);
  context.closePath();
  context.fill();

  // The roof fold, and the outline that keeps it legible when it is four pixels
  // long — which is most of the time, at the zoom this game plays at.
  context.strokeStyle = Ink.graphite;
  context.beginPath();
  context.moveTo(l, 0);
  context.lineTo(-l, 0);
  context.stroke();

  context.beginPath();
  context.moveTo(l, 0);
  context.lineTo(l * 0.35, -w);
  context.lineTo(-l, -w * 0.85);
  context.lineTo(-l, w * 0.85);
  context.lineTo(l * 0.35, w);
  context.closePath();
  context.stroke();
}

/**
 * A waiting passenger: a folded figure.
 *
 * A standing crane-fold — a triangular body with a head folded forward. Rush
 * fares lean, Meter fares stand square, which is a posture difference readable
 * at a glance and costs no colour.
 */
export function passenger(context: PaperContext, rush: boolean): void {
  const height = 2.2;
  const half = 0.8;
  const lean = rush ? 0.45 : 0;

  context.fillStyle = rush ? Ink.crease : Ink.graphite;
  context.beginPath();
  context.moveTo(lean, -height);
  context.lineTo(half, 0);
  context.lineTo(-half, 0);
  context.closePath();
  context.fill();

  // The head, folded forward off the top of the body.
  context.beginPath();
  context.moveTo(lean, -height);
  context.lineTo(lean + half * 0.9, -height * 0.72);
  context.lineTo(lean - half * 0.2, -height * 0.66);
  context.closePath();
  context.fill();
}

/**
 * A destination: the sheet scored where a fare ends.
 *
 * A hollow diamond rather than a filled marker, so it never competes with a
 * passenger for attention — you are looking for people, and the destination is
 * somewhere you already know you are going.
 */
export function destination(context: PaperContext, size: number): void {
  context.strokeStyle = Ink.crease;
  context.beginPath();
  context.moveTo(0, -size);
  context.lineTo(size, 0);
  context.lineTo(0, size);
  context.lineTo(-size, 0);
  context.closePath();
  context.stroke();
}

/**
 * A landmark silhouette — the thing you navigate by.
 *
 * `DESIGN.md` §2.4 rules out a floating destination arrow, which makes these
 * the only wayfinding in the game. So they are drawn as a taller, sharper flap
 * than any building around them: a folded peak that breaks the skyline of its
 * district and is recognisable from across the city at a glance.
 */
export function landmark(context: PaperContext, size: number): void {
  context.fillStyle = Ink.graphite;
  context.beginPath();
  context.moveTo(0, -size * 1.6);
  context.lineTo(size * 0.75, size * 0.4);
  context.lineTo(0, size * 0.1);
  context.closePath();
  context.fill();

  context.fillStyle = Ink.graphiteSoft;
  context.beginPath();
  context.moveTo(0, -size * 1.6);
  context.lineTo(-size * 0.75, size * 0.4);
  context.lineTo(0, size * 0.1);
  context.closePath();
  context.fill();
}

/**
 * A motion particle — a torn scrap of the sheet.
 *
 * Accent-coloured, because ADR 0001 spends the accent on motion and this is
 * what motion looks like. Drawn as a small hard-edged shard rather than a
 * circle: a puff of smoke belongs to a different world than a folded one.
 */
export function scrap(context: PaperContext, size: number, fade: number): void {
  context.fillStyle = fade > 0.5 ? Ink.crane : Ink.craneDark;
  context.beginPath();
  context.moveTo(size, 0);
  context.lineTo(0, size * 0.7);
  context.lineTo(-size * 0.8, 0);
  context.lineTo(0, -size * 0.5);
  context.closePath();
  context.fill();
}
