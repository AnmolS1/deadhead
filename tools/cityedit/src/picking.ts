/**
 * `picking.ts` — what is under the cursor, and where a click lands.
 *
 * The logic beneath the editor's canvas. Separated from the canvas because it
 * is pure geometry over a {@link CityJson} and therefore testable without a
 * browser — and because hit-testing is where an editor's most irritating bugs
 * live. A click that selects the road instead of the junction on top of it is
 * not a crash; it is a tool that fights you all afternoon.
 *
 * ## Priority is the whole design
 *
 * Elements overlap constantly and by construction: a junction sits *on* the two
 * roads that meet there; a spawn sits beside a road; a landmark sits inside a
 * building. So "what is under the cursor" is never just a containment test —
 * it is an ordering question, and the order has to match what the author means
 * rather than what the data structure happens to list first.
 *
 * The order here is **smallest and most specific first**:
 *
 * ```
 *   junction  →  spawn / destination / landmark  →  demand anchor
 *             →  road  →  building
 * ```
 *
 * A junction beats the roads through it, because you can always click the road
 * further along and you can never click the junction anywhere else. Buildings
 * are last because they are large: a building under everything else would
 * otherwise swallow every click inside its footprint.
 *
 * ## Tolerance is in world units, and that matters
 *
 * The caller converts the cursor to world space (`screenToWorld`, from the game
 * renderer, which `W-02`'s brief asks the editor to reuse) and passes a
 * tolerance in world units. It must be derived from the current zoom —
 * `pixels / (zoom * pixelsPerUnit)` — or picking gets harder as you zoom out,
 * which reads as the tool becoming inaccurate rather than as a fixed radius
 * behaving correctly.
 */
import type { CityJson } from '@deadhead/proto';

import { distanceToSegment, nearestRoad, pointInBox, reachFromCentreline } from './audit.js';

/** What the cursor is over. */
export interface Pick {
  readonly kind: 'node' | 'edge' | 'building' | 'spawn' | 'destination' | 'landmark' | 'anchor';
  readonly index: number;
  /** Distance in world units. Zero inside an area element. */
  readonly distance: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The element under a world-space point, or `null`.
 *
 * Ties within a kind are broken by distance, then by lowest index, so repeated
 * clicks on the same spot always select the same thing. A picker whose result
 * varies under an identical click is one nobody can build a habit around.
 */
export function pick(city: CityJson, at: Point, tolerance: number): Pick | null {
  const nearestOf = (kind: Pick['kind'], points: readonly Point[]): Pick | null => {
    let best: Pick | null = null;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      const distance = Math.hypot(point.x - at.x, point.y - at.y);
      if (distance > tolerance) continue;
      if (best === null || distance < best.distance) best = { kind, index, distance };
    }
    return best;
  };

  // 1. Junctions. On top of the roads that meet there, always.
  const node = nearestOf('node', city.nodes);
  if (node !== null) return node;

  // 2. Markers. All the same size, so nearest wins across the three kinds; the
  //    listed order breaks an exact tie.
  const markers = [
    nearestOf('spawn', city.spawns),
    nearestOf('destination', city.destinations),
    nearestOf('landmark', city.landmarks),
    nearestOf('anchor', city.demandAnchors),
  ].filter((candidate): candidate is Pick => candidate !== null);

  if (markers.length > 0) {
    return markers.reduce((best, candidate) =>
      candidate.distance < best.distance ? candidate : best,
    );
  }

  // 3. Roads.
  let bestEdge: Pick | null = null;
  for (let index = 0; index < city.edges.length; index += 1) {
    const edge = city.edges[index]!;
    const a = city.nodes[edge.a];
    const b = city.nodes[edge.b];
    if (a === undefined || b === undefined) continue;

    // Half the carriageway, so a click anywhere on the road surface counts,
    // plus the caller's tolerance for the usual near-miss.
    const reach = edge.width / 2 + tolerance;
    const distance = distanceToSegment(at, a.x, a.y, b.x, b.y);
    if (distance > reach) continue;
    if (bestEdge === null || distance < bestEdge.distance) {
      bestEdge = { kind: 'edge', index, distance };
    }
  }
  if (bestEdge !== null) return bestEdge;

  // 4. Buildings, last, because they are large enough to swallow everything.
  //    Smallest first, so a small prop on a big block is still selectable.
  let bestBuilding: Pick | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (let index = 0; index < city.buildings.length; index += 1) {
    const box = city.buildings[index]!;
    if (!pointInBox(at, box)) continue;
    const area = (box.maxX - box.minX) * (box.maxY - box.minY);
    if (area < bestArea) {
      bestArea = area;
      bestBuilding = { kind: 'building', index, distance: 0 };
    }
  }
  return bestBuilding;
}

export interface SnapOptions {
  /** Grid spacing in world units. Zero or less disables grid snapping. */
  readonly grid: number;
  /** Snap to an existing junction within this distance, in world units. */
  readonly nodeRadius: number;
  /** Snap onto a road centreline within this distance, in world units. */
  readonly edgeRadius: number;
  /**
   * How far from a road a passenger click still counts as "beside that road".
   *
   * Deliberately much larger than the kerb offset it produces. Catching should
   * be **generous** and landing should be **precise**: a spawn or destination
   * has to be near a road to function at all, so a click that misses by a dozen
   * units still plainly means "beside this street", and yanking it to the kerb
   * is more useful than honouring the exact pixel and leaving a point no cab
   * can serve.
   *
   * The first version reused `edgeRadius` (8) for this. A click 13 units from a
   * road — about 26 CSS pixels at a normal editing zoom, which reads as *on*
   * the road — fell through to the grid and produced an unreachable
   * destination. The audit caught it, but being caught by the audit is worse
   * than not happening.
   */
  readonly kerbCatchment: number;
}

export const DEFAULT_SNAP: SnapOptions = {
  grid: 10,
  nodeRadius: 12,
  edgeRadius: 8,
  kerbCatchment: 24,
};

export interface Snap {
  readonly point: Point;
  /** What it snapped to. `'none'` means the raw point, rounded to the grid. */
  readonly to: 'node' | 'edge' | 'grid' | 'none';
  /** Index of the junction or road snapped to, when there is one. */
  readonly index?: number;
}

/**
 * Where a click should actually land.
 *
 * Order matters as much as it does in {@link pick}, for the same reason:
 *
 * 1. **An existing junction**, so drawing a road that meets another road
 *    *connects* to it. This is the one that must come first. Snapping to the
 *    grid instead would leave a junction one unit away from the one already
 *    there — two roads crossing with no connection between them, which looks
 *    correct on screen and produces an `unreachable` finding the author cannot
 *    see the cause of.
 * 2. **A road**, so a new junction lands on the carriageway and
 *    {@link CityDocument.splitEdge} has something exact to split.
 * 3. **The grid**, so freehand placement stays tidy.
 */
export function snap(city: CityJson, at: Point, options: Partial<SnapOptions> = {}): Snap {
  const settings = { ...DEFAULT_SNAP, ...options };

  // 1. An existing junction.
  let bestNode = -1;
  let bestNodeDistance = settings.nodeRadius;
  for (let index = 0; index < city.nodes.length; index += 1) {
    const node = city.nodes[index]!;
    const distance = Math.hypot(node.x - at.x, node.y - at.y);
    if (distance <= bestNodeDistance) {
      bestNodeDistance = distance;
      bestNode = index;
    }
  }
  if (bestNode !== -1) {
    const node = city.nodes[bestNode]!;
    return { point: { x: node.x, y: node.y }, to: 'node', index: bestNode };
  }

  // 2. A road centreline.
  let bestEdge = -1;
  let bestEdgeDistance = settings.edgeRadius;
  let bestPoint: Point = at;
  for (let index = 0; index < city.edges.length; index += 1) {
    const edge = city.edges[index]!;
    const a = city.nodes[edge.a];
    const b = city.nodes[edge.b];
    if (a === undefined || b === undefined) continue;

    const distance = distanceToSegment(at, a.x, a.y, b.x, b.y);
    if (distance <= bestEdgeDistance) {
      bestEdgeDistance = distance;
      bestEdge = index;
      bestPoint = closestPointOnSegment(at, a, b);
    }
  }
  if (bestEdge !== -1) {
    return {
      // Rounded, because a junction at x = 41.37219 is a nuisance in a JSON
      // file a human has to read, and the format stores whole units anyway.
      point: { x: Math.round(bestPoint.x), y: Math.round(bestPoint.y) },
      to: 'edge',
      index: bestEdge,
    };
  }

  // 3. The grid.
  if (settings.grid > 0) {
    return {
      point: {
        x: Math.round(at.x / settings.grid) * settings.grid,
        y: Math.round(at.y / settings.grid) * settings.grid,
      },
      to: 'grid',
    };
  }

  return { point: { x: Math.round(at.x), y: Math.round(at.y) }, to: 'none' };
}

/** The point on a segment closest to `at`. */
function closestPointOnSegment(at: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { x: a.x, y: a.y };

  let t = ((at.x - a.x) * dx + (at.y - a.y) * dy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/**
 * Pick tolerance in world units for a given zoom.
 *
 * A fixed *pixel* tolerance is what the author experiences — the cursor is
 * always the same size on screen — so it has to be converted per frame. Using a
 * fixed world tolerance instead makes picking feel progressively less accurate
 * as you zoom out, which reads as a broken tool rather than as a constant
 * radius doing what it says.
 */
export function toleranceForZoom(pixels: number, zoom: number, pixelsPerUnit: number): number {
  const scale = zoom * pixelsPerUnit;
  return scale > 0 ? pixels / scale : pixels;
}

// ---------------------------------------------------------------------------
// Kerbside snapping
// ---------------------------------------------------------------------------

/** Where a kerb snap put a point, and against which road. */
export interface KerbSnap {
  readonly point: Point;
  /** The road it was placed beside, or `-1` when none was near enough. */
  readonly road: number;
  /** True when the point was placed at a kerb rather than falling back. */
  readonly onKerb: boolean;
}

/**
 * Snap a passenger point to the kerb of the nearest road.
 *
 * Spawns and destinations are **people**, and people stand on the pavement. The
 * general {@link snap} puts road centrelines ahead of the grid, which is right
 * for junctions and wrong here: it drops passengers in the middle of the
 * carriageway, so the authored data says something the world does not mean.
 *
 * This projects onto the nearest road, then steps **perpendicular** to the
 * carriageway edge, on whichever side the click was. The offset is `width / 2`
 * — exactly the kerb line — and that number is load-bearing rather than
 * cosmetic:
 *
 * - `FareTuning.pickupRadius` is 3 units, and a cab's centre can sit at most
 *   `width/2 - halfWidth` from the centreline. On a standard 8-wide road that
 *   is 3.5, so a passenger is reachable out to 6.5.
 * - At the kerb (4 units out) a cab in the near lane is comfortably inside
 *   that, a cab hugging the far kerb is not, and a cab exactly on the
 *   centreline is 4 units away — *just* out of reach.
 *
 * So pulling over is required, and pulling over on the correct side is
 * required, which is what a taxi game should ask for. Placing passengers
 * further out than the kerb would start making fares impossible rather than
 * demanding.
 *
 * Falls back to the grid when nothing is near enough to have a kerb.
 */
export function snapKerb(
  city: CityJson,
  at: Point,
  kind: 'spawn' | 'destination' = 'spawn',
  options: Partial<SnapOptions> = {},
): KerbSnap {
  const settings = { ...DEFAULT_SNAP, ...options };
  const road = nearestRoad(at, city);

  // Generous catching, precise landing — see `kerbCatchment`. Beyond it the
  // author plainly meant open ground rather than a kerb.
  const catchment = Math.max(settings.kerbCatchment, reachFromCentreline(road?.width ?? 0, kind));
  if (road === null || road.distance > catchment) {
    return { point: gridPoint(at, settings.grid), road: -1, onKerb: false };
  }

  const edge = city.edges[road.index]!;
  const a = city.nodes[edge.a]!;
  const b = city.nodes[edge.b]!;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { point: gridPoint(at, settings.grid), road: -1, onKerb: false };

  const foot = closestPointOnSegment(at, a, b);
  // Left-hand normal to the road. Either side is a kerb; which one is decided
  // by where the click was.
  const nx = -dy / length;
  const ny = dx / length;

  const side = Math.sign((at.x - foot.x) * nx + (at.y - foot.y) * ny) || 1;
  const offset = edge.width / 2;

  return {
    // Whole units, because the format stores whole units. The rounding moves
    // the point by under a unit, which the reach has ample room for.
    point: {
      x: Math.round(foot.x + nx * side * offset),
      y: Math.round(foot.y + ny * side * offset),
    },
    road: road.index,
    onKerb: true,
  };
}

function gridPoint(at: Point, grid: number): Point {
  if (grid <= 0) return { x: Math.round(at.x), y: Math.round(at.y) };
  return { x: Math.round(at.x / grid) * grid, y: Math.round(at.y / grid) * grid };
}
