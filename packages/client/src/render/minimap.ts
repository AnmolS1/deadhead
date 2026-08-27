/**
 * `render/minimap.ts` — `W-06`. Wayfinding without an arrow.
 *
 * **The problem this solves, precisely.** City 01 has **19 destinations and they
 * are all drawn identically**, so a player carrying a fare has no way to tell
 * which one is theirs. Anmol's first playtest reported it as *"it's not clear
 * where a pickup must be dropped off"*, and the cause was not that the target
 * was hidden — it was that the target was indistinguishable from eighteen
 * decoys.
 *
 * **No floating arrow.** `DESIGN.md` §2.4 rules it out on design grounds, not
 * legal ones — Sega's patent (US 6,200,138) expired in 2018. An arrow turns
 * navigation into following a needle, and route knowledge is the skill this game
 * is about. `W-06`'s sanctioned answer is a corner minimap showing **the local
 * grid and your destination**, plus landmarks (`W-05` already draws those).
 *
 * **The demand field is deliberately absent.** `W-06`'s brief listed it and
 * `D-04` struck it: §7.4 says demand is invisible, because a heat map turns a
 * thing you *learn* into a thing you *read*.
 *
 * This is a map, not a radar: it shows where things ARE, oriented the way the
 * world is, and leaves working out the route to the player.
 */
import { Ink } from './palette.js';
import { type PaperContext } from './paper.js';

export interface MinimapContext extends PaperContext {
  globalAlpha: number;
}

export interface MinimapViewport {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface MinimapEdge {
  readonly a: Point;
  readonly b: Point;
}

export interface MinimapInput {
  /** Where the cab is, in world units. */
  readonly eye: Point;
  /** Road segments, world units. Culled to the window by this module. */
  readonly edges: readonly MinimapEdge[];
  /** Landmarks — the wayfinding `W-05` already draws in-world. */
  readonly landmarks: readonly Point[];
  /** The active fare's destination, or `null` when the cab is empty. */
  readonly destination: Point | null;
  /**
   * Insets from `C-08`'s fold, as fractions. The minimap rides inside the
   * folded field rather than being eaten by it.
   */
  readonly insets: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
}

export const MinimapTuning = {
  /** Side of the map, as a fraction of the smaller viewport dimension. */
  sizeFraction: 0.17,
  /** Minimum side in device pixels, so it stays usable on a phone. */
  minSizePx: 96,
  /**
   * World units visible across the map.
   *
   * City 01's median junction spacing is 25 units, so 220 shows roughly eight
   * blocks each way — enough to place yourself in the grid without becoming a
   * whole-city view, which would make it a route planner rather than a compass.
   */
  windowUnits: 220,
  /** Gap from the folded edge, in device pixels. */
  padPx: 14,
} as const;

/**
 * Where the destination marker sits when the destination is outside the window.
 *
 * Clamped to the map's rim rather than dropped. **This is the one thing that
 * makes the map answer "which way", and it is deliberately as far as it goes**:
 * a rim marker says *that direction, off the map*, which still requires the
 * player to know the city to get there. An arrow in the world would say *follow
 * me*, which is what §2.4 rules out.
 */
function clampToRim(dx: number, dy: number, half: number): Point {
  const max = Math.max(Math.abs(dx), Math.abs(dy));
  if (max <= half) return { x: dx, y: dy };
  const scale = half / max;
  return { x: dx * scale, y: dy * scale };
}

export function renderMinimap(
  context: MinimapContext,
  viewport: MinimapViewport,
  input: MinimapInput,
): void {
  const side = Math.max(
    MinimapTuning.minSizePx,
    Math.round(Math.min(viewport.width, viewport.height) * MinimapTuning.sizeFraction),
  );
  const half = side / 2;

  // Bottom-left, inside the fold. The clock is top-right; keeping them on
  // opposite corners means neither has to move as the field closes in.
  const left = input.insets.left * viewport.width + MinimapTuning.padPx;
  const top = viewport.height - input.insets.bottom * viewport.height - MinimapTuning.padPx - side;
  const cx = left + half;
  const cy = top + half;

  const unitsToPx = side / MinimapTuning.windowUnits;
  const project = (p: Point): Point => ({
    x: (p.x - input.eye.x) * unitsToPx,
    y: (p.y - input.eye.y) * unitsToPx,
  });

  context.save();

  // The sheet the map is printed on.
  context.globalAlpha = 0.82;
  context.fillStyle = Ink.paperLit;
  context.fillRect(left, top, side, side);
  context.globalAlpha = 1;

  // --- roads ---------------------------------------------------------------
  // Drawn as plain strokes, clipped by a bounds test rather than by a clip path:
  // `PaperContext` has no `clip`, and adding one for this would widen the art
  // interface for a piece of chrome.
  // `Ink.creaseFaint`, not `Ink.grid`. The grid ink is 7% alpha because in the
  // world it is a texture you should barely notice; at map scale that is simply
  // illegible. **The map is chrome, not world art** — it is allowed to be more
  // readable than the thing it depicts, and it has to be, because it exists to
  // be glanced at.
  context.strokeStyle = Ink.creaseFaint;
  context.lineWidth = 1.5;
  context.setLineDash([]);
  for (const edge of input.edges) {
    const a = project(edge.a);
    const b = project(edge.b);
    if (!segmentTouchesBox(a, b, half)) continue;
    context.beginPath();
    context.moveTo(cx + clamp(a.x, half), cy + clamp(a.y, half));
    context.lineTo(cx + clamp(b.x, half), cy + clamp(b.y, half));
    context.stroke();
  }

  // --- landmarks -----------------------------------------------------------
  // The same silhouettes `W-05` put in the world. Repeating them here is what
  // ties map to world: a player recognises the shape they just drove past.
  context.fillStyle = Ink.graphiteShadow;
  for (const landmark of input.landmarks) {
    const p = project(landmark);
    if (Math.abs(p.x) > half || Math.abs(p.y) > half) continue;
    context.fillRect(cx + p.x - 2, cy + p.y - 2, 4, 4);
  }

  // --- your destination ----------------------------------------------------
  if (input.destination !== null) {
    const p = project(input.destination);
    const rim = clampToRim(p.x, p.y, half - 4);
    const offMap = Math.abs(p.x) > half - 4 || Math.abs(p.y) > half - 4;

    context.fillStyle = Ink.crane;
    if (offMap) {
      // Hollow on the rim: "that way, further than this map shows". Solid would
      // claim a position it does not know.
      context.globalAlpha = 0.55;
      context.fillRect(cx + rim.x - 3, cy + rim.y - 3, 6, 6);
      context.globalAlpha = 1;
    } else {
      context.fillRect(cx + rim.x - 3.5, cy + rim.y - 3.5, 7, 7);
    }
  }

  // --- the cab -------------------------------------------------------------
  // Always dead centre: the map is cab-relative, which is what makes it
  // readable at a glance without rotating.
  //
  // Drawn larger than a landmark and in full graphite so the eye lands on it
  // first. A "you are here" that reads the same as a landmark is not a "you are
  // here" — it is a fifth landmark.
  context.fillStyle = Ink.graphite;
  context.fillRect(cx - 3, cy - 3, 6, 6);

  // The fold of the map's own sheet — one crease, so it reads as paper rather
  // than as a UI panel.
  context.strokeStyle = Ink.foldShadow;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(left, top);
  context.lineTo(left + side, top);
  context.lineTo(left + side, top + side);
  context.lineTo(left, top + side);
  context.closePath();
  context.stroke();

  context.restore();
}

function clamp(value: number, half: number): number {
  return value < -half ? -half : value > half ? half : value;
}

/** Cheap reject: does the segment come anywhere near the map window? */
function segmentTouchesBox(a: Point, b: Point, half: number): boolean {
  if (a.x < -half && b.x < -half) return false;
  if (a.x > half && b.x > half) return false;
  if (a.y < -half && b.y < -half) return false;
  if (a.y > half && b.y > half) return false;
  return true;
}
