/**
 * `render/city.ts` — painting the sheet.
 *
 * The static half of the world: paper, ruling, street valleys, fold shadows and
 * flaps. None of it changes during a run, so it is painted **once per chunk**
 * into `chunks.ts`'s cache and blitted thereafter — which is what makes an
 * aesthetic built from a few hundred hard-edged polygons cost nothing per
 * frame.
 *
 * ## The pass order is the whole illusion
 *
 * ```
 *   paper      the sheet
 *   ruling     graph-paper texture, barely there
 *   valleys    streets pressed into it
 *   shadows    EVERY flap's shadow, before any flap
 *   flaps      buildings, lifted
 * ```
 *
 * The fourth line is the one that matters and the one that is easy to get
 * wrong. Drawing each building's shadow immediately before that building —
 * the obvious way — lets a shadow fall *on top of* its neighbour, and paper
 * does not work that way: a raised flap shades the sheet, not the flap beside
 * it. Interleaved, a city reads as stickers on a background. Batched, it reads
 * as one sheet in relief.
 */
import { EdgeFlags, type CityJson } from '@deadhead/proto';

import { Ink } from './palette.js';
import {
  centreCrease,
  flap,
  flapEdge,
  flapShadow,
  ruling,
  valley,
  type Box,
  type PaperContext,
} from './paper.js';

/** Graph-paper spacing, in world units. */
const RULING = 20;

/** Below this carriageway width a centre crease is noise rather than a marking. */
const CENTRE_CREASE_MIN_WIDTH = 8;

export interface CityPaintOptions {
  /** The world-space rectangle being painted. */
  readonly bounds: Box;
  /** Device pixels per world unit, for hairline widths. */
  readonly scale: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Grow a box, so geometry just outside still casts its shadow inward. */
function grown(box: Box, by: number): Box {
  return {
    minX: box.minX - by,
    minY: box.minY - by,
    maxX: box.maxX + by,
    maxY: box.maxY + by,
  };
}

/**
 * Paint the static city into a context already transformed to world space.
 *
 * Everything overlapping `bounds` is drawn, including geometry whose centre is
 * outside it — a building just off the edge of a chunk still casts its shadow
 * into that chunk, and culling on centres would leave a visible seam at every
 * chunk boundary.
 */
export function paintCity(context: PaperContext, city: CityJson, options: CityPaintOptions): void {
  const { bounds, scale } = options;
  const hairline = 1 / scale;
  // Generous, so shadows and wide carriageways from outside still reach in.
  const reach = grown(bounds, 40);

  // 1. The sheet.
  context.fillStyle = Ink.paper;
  context.fillRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);

  // 2. The ruling. Barely visible by design — it reads as the texture of the
  //    paper, and gives the eye something to measure speed against on an
  //    otherwise empty page.
  ruling(context, bounds, RULING, hairline);

  // 3. Streets, pressed into the sheet.
  context.lineWidth = hairline;
  for (const edge of city.edges) {
    const a = city.nodes[edge.a];
    const b = city.nodes[edge.b];
    if (a === undefined || b === undefined) continue;
    if (!segmentNear(a, b, reach)) continue;
    valley(context, a.x, a.y, b.x, b.y, edge.width);
  }

  // 4. Centre creases, on the streets wide enough to carry one. Drawn after
  //    every valley so a junction does not paint over the marking beside it.
  for (const edge of city.edges) {
    if (edge.width < CENTRE_CREASE_MIN_WIDTH) continue;
    const a = city.nodes[edge.a];
    const b = city.nodes[edge.b];
    if (a === undefined || b === undefined) continue;
    if (!segmentNear(a, b, reach)) continue;
    // A one-way street gets no centre crease: there is nothing to divide.
    if (((edge.flags ?? 0) & EdgeFlags.OneWay) !== 0) continue;
    context.lineWidth = hairline;
    centreCrease(context, a.x, a.y, b.x, b.y, scale);
  }

  // 5. Every shadow, before any flap. See the note at the top of this file.
  const visible = city.buildings.filter((box) => overlaps(box, reach));
  for (const box of visible) flapShadow(context, box);

  // 6. The flaps themselves.
  context.lineWidth = hairline;
  for (const box of visible) {
    flap(context, box);
    flapEdge(context, box, hairline);
  }
}

/** Cheap reject for a street entirely outside the region being painted. */
function segmentNear(a: { x: number; y: number }, b: { x: number; y: number }, box: Box): boolean {
  return (
    Math.min(a.x, b.x) <= box.maxX &&
    Math.max(a.x, b.x) >= box.minX &&
    Math.min(a.y, b.y) <= box.maxY &&
    Math.max(a.y, b.y) >= box.minY
  );
}
