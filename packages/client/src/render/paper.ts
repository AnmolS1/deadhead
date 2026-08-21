/**
 * `render/paper.ts` — the folded-sheet primitives.
 *
 * The whole art direction reduces to three moves, and everything in the city is
 * one of them:
 *
 * - **a flap** — a piece of the sheet lifted, with a lit face and a shadow it
 *   drops on the paper below (buildings, props);
 * - **a valley** — a piece pressed down, darker, with the sheet bending along
 *   its edges (streets);
 * - **a crease** — the line the sheet bends along, drawn and nothing more.
 *
 * ## Why the light never moves
 *
 * Every shadow here is cast from {@link LIGHT}, one direction, for the entire
 * city, for the entire game. That single constraint is what makes a screen full
 * of separate buildings read as **one sheet lifted into relief** rather than as
 * a collection of boxes sitting on a background.
 *
 * It is also the thing most likely to be broken by accident later — a shadow
 * offset written by hand at a call site, a light that follows the camera
 * because it looked nicer in one screenshot. Both destroy the effect in a way
 * that is hard to name and impossible to miss, so the offset is computed here
 * and nowhere else.
 *
 * ## Hard edges, always
 *
 * No gradients, no blur, no rounded corners. A gradient is what paper does not
 * do: a fold is a discontinuity, and the hard edge between a lit face and a
 * shadowed one is the entire reason the shape reads as folded. It is also why
 * the aesthetic is cheap to render — flat fills and straight lines, no
 * `shadowBlur`, which is the single most expensive thing in Canvas 2D.
 */
import { FOLD_DEPTH, Ink, LIGHT } from './palette.js';

/** The 2D context operations these primitives use. */
export interface PaperContext {
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  // `number[]`, not `readonly number[]` — lib.dom declares it mutable, and a
  // narrower parameter here makes a real canvas fail to satisfy the interface.
  setLineDash(segments: number[]): void;
  // The union lib.dom declares, not the `string` this file actually assigns.
  // Narrowing a *property* makes the real canvas fail to satisfy the interface
  // — a wider type on the implementation is not assignable to a narrower one.
  //
  // The art never uses a gradient or a pattern. That is a rule about the
  // aesthetic (a fold is a hard discontinuity; a gradient is what paper does
  // not do), not something the type should be trying to enforce.
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
}

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** How far a flap's shadow falls, on each axis. Derived once, from the light. */
export const SHADOW_X = LIGHT.x * FOLD_DEPTH;
export const SHADOW_Y = LIGHT.y * FOLD_DEPTH;

/**
 * The sheet a raised flap drops on the paper.
 *
 * Drawn as its own pass, **before any flap**, so that shadows never fall on top
 * of a neighbouring building. Paper does not work that way: a flap shades the
 * sheet, not the flap beside it, and drawing them interleaved produces a city
 * that looks like it is made of stickers.
 */
export function flapShadow(context: PaperContext, box: Box): void {
  context.fillStyle = Ink.foldShadow;

  // The silhouette of the box swept along the light direction: the box at its
  // offset position, plus the two quadrilaterals joining the two positions.
  const { minX, minY, maxX, maxY } = box;
  const sx = SHADOW_X;
  const sy = SHADOW_Y;

  context.beginPath();
  // Walking the swept hull. With a light pointing down-right the hull is the
  // original box, the offset box, and the connecting faces on the two lit sides.
  context.moveTo(minX, minY);
  context.lineTo(maxX, minY);
  context.lineTo(maxX + sx, minY + sy);
  context.lineTo(maxX + sx, maxY + sy);
  context.lineTo(minX + sx, maxY + sy);
  context.lineTo(minX, maxY);
  context.closePath();
  context.fill();
}

/**
 * A piece of the sheet lifted — a building.
 *
 * **Facets, not extrusion.** The first version drew fake side-faces, as though
 * the box were a solid seen at a slight angle. That is wrong for a pure
 * top-down view: with no perspective there are no sides to see, and what it
 * actually produced was a white rectangle with a soft drop shadow — Material
 * Design elevation, in a game about folded paper.
 *
 * A folded form seen from above is a **crease pattern**: one surface divided by
 * fold lines into faces that catch the light differently. So the top is split
 * along its diagonal, the half turned toward {@link LIGHT} is the brighter
 * paper, the other half is a shade down, and the crease between them is drawn.
 * That is what a folded sheet looks like from directly overhead, and it costs
 * two fills and a line.
 */
export function flap(context: PaperContext, box: Box): void {
  const { minX, minY, maxX, maxY } = box;

  // Fold along the diagonal that runs across the light, so the two faces are
  // genuinely lit differently rather than symmetrically.
  const litFirst = LIGHT.x * LIGHT.y > 0;
  const [a, b, c, d] = litFirst
    ? ([
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
      ] as const)
    : ([
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
        [minX, minY],
      ] as const);

  // The face turned toward the light.
  context.fillStyle = Ink.paperLit;
  context.beginPath();
  context.moveTo(a[0], a[1]);
  context.lineTo(b[0], b[1]);
  context.lineTo(c[0], c[1]);
  context.closePath();
  context.fill();

  // The face turned away — the same paper, a clear value down. The first
  // version used paperLit against paperHighlight, a difference of two points
  // of luminance: the fold read as a stray line on a white box rather than as
  // a crease.
  context.fillStyle = Ink.foldShade;
  context.beginPath();
  context.moveTo(a[0], a[1]);
  context.lineTo(c[0], c[1]);
  context.lineTo(d[0], d[1]);
  context.closePath();
  context.fill();

  // The fold itself.
  context.strokeStyle = Ink.creaseBold;
  context.beginPath();
  context.moveTo(a[0], a[1]);
  context.lineTo(c[0], c[1]);
  context.stroke();
}

/**
 * The outline that makes a flap legible when it is only a few pixels across.
 *
 * `W-05`'s done-when is *"legible at thumbnail size"*, and at thumbnail size a
 * fill is a smudge. The outline is what survives.
 */
export function flapEdge(context: PaperContext, box: Box, width: number): void {
  context.strokeStyle = Ink.graphite;
  context.lineWidth = width;
  context.lineJoin = 'miter';
  context.beginPath();
  context.moveTo(box.minX, box.minY);
  context.lineTo(box.maxX, box.minY);
  context.lineTo(box.maxX, box.maxY);
  context.lineTo(box.minX, box.maxY);
  context.closePath();
  context.stroke();
}

/**
 * A valley — the sheet pressed down, which is what a street is here.
 *
 * Drawn as a slightly darker band than the paper rather than as asphalt. The
 * distinction matters: a grey strip on a cream background is a road drawn on
 * paper, and this is supposed to be a road *made of* paper. The value shift is
 * deliberately small; the crease lines along the edges do the work.
 */
export function valley(
  context: PaperContext,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  // Perpendicular, scaled to half the carriageway.
  const nx = (-dy / length) * (width / 2);
  const ny = (dx / length) * (width / 2);

  // A shade below the sheet, because the street is pressed into it. The first
  // version used the paper colour itself, which is exactly as visible as it
  // sounds: the roads vanished and only their edge creases showed.
  //
  // Derived rather than invented — `--color-crease` at low alpha, so a street
  // is the crease colour spread thin rather than a new grey nobody chose.
  context.fillStyle = Ink.roadSurface;
  context.beginPath();
  context.moveTo(ax + nx, ay + ny);
  context.lineTo(bx + nx, by + ny);
  context.lineTo(bx - nx, by - ny);
  context.lineTo(ax - nx, ay - ny);
  context.closePath();
  context.fill();

  // The two creases the sheet bends along. These are the street, visually —
  // more than the surface between them.
  context.strokeStyle = Ink.creaseBold;
  context.beginPath();
  context.moveTo(ax + nx, ay + ny);
  context.lineTo(bx + nx, by + ny);
  context.moveTo(ax - nx, ay - ny);
  context.lineTo(bx - nx, by - ny);
  context.stroke();
}

/**
 * The centre crease of a street, dashed.
 *
 * The one piece of road *marking* in the game, and it is a crease rather than
 * painted line — a dashed fold, as though the sheet were scored to be folded
 * again later. Skipped on narrow streets, where it would be noise.
 */
export function centreCrease(
  context: PaperContext,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  scale: number,
): void {
  context.save();
  context.strokeStyle = Ink.creaseFaint;
  context.setLineDash([6, 5]);
  context.beginPath();
  context.moveTo(ax, ay);
  context.lineTo(bx, by);
  context.stroke();
  context.restore();
  void scale;
}

/**
 * The ruling underneath everything — graph paper.
 *
 * ponderance calls this `--color-grid-line` and describes it as "the blueprint
 * graph-paper ground". It is barely visible by design: at 7% opacity it reads
 * as the texture of the sheet rather than as a grid, and it gives the eye
 * something to measure speed against on an otherwise empty page.
 */
export function ruling(context: PaperContext, box: Box, spacing: number, lineWidth: number): void {
  context.strokeStyle = Ink.grid;
  context.lineWidth = lineWidth;
  context.beginPath();

  const firstX = Math.ceil(box.minX / spacing) * spacing;
  for (let x = firstX; x <= box.maxX; x += spacing) {
    context.moveTo(x, box.minY);
    context.lineTo(x, box.maxY);
  }
  const firstY = Math.ceil(box.minY / spacing) * spacing;
  for (let y = firstY; y <= box.maxY; y += spacing) {
    context.moveTo(box.minX, y);
    context.lineTo(box.maxX, y);
  }
  context.stroke();
}
