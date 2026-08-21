/**
 * `builder.ts` — authoring helpers for a hand-designed city.
 *
 * `W-03` asks for a *hand-authored* city, and this is what that means in
 * practice: a script rather than three thousand lines of JSON. The reasons are
 * the same ones that make source better than output anywhere else — it diffs,
 * it takes comments explaining *why* a street bends, it can be re-run when a
 * constant changes, and a reviewer can read the intent instead of coordinates.
 * The editor stays the tool for judgement; this keeps the result in version
 * control as something a person can argue with.
 *
 * The one thing a script must not lose against clicking is **junction identity**.
 * Two streets that cross have to *share* a junction, not stack two a unit apart
 * — the failure `audit` reports as `unreachable` and nobody can see on a map.
 * {@link Builder.at} dedupes by coordinate so a crossing is a crossing.
 */
import { EdgeFlags, type CityBox, type CityJson, type CityPoint } from '@deadhead/proto';

import { CityDocument } from '../document.js';
import { snapKerb } from '../picking.js';

export interface StreetOptions {
  /** Carriageway width in whole units. */
  readonly width?: number;
  /** One-way, in the order the points were given. */
  readonly oneWay?: boolean;
  /** Street name, for `W-06`'s signage. */
  readonly name?: string;
}

export class Builder {
  readonly doc: CityDocument;
  /** Junction index by `"x,y"`, so a crossing is one junction and not two. */
  private readonly junctions = new Map<string, number>();

  constructor(name: string) {
    this.doc = new CityDocument({
      version: 0,
      name,
      nodes: [],
      edges: [],
      buildings: [],
      spawns: [],
      destinations: [],
      demandAnchors: [],
      landmarks: [],
      names: [],
    });
  }

  /**
   * The junction at a point, creating it only if there is not one already —
   * and **splitting any street that already runs through it**.
   *
   * The split is the part that matters. A long avenue is authored as one edge
   * from end to end, so a side street joining it halfway has nothing to attach
   * to: `at()` would mint a junction sitting *on top of* the road without
   * joining it, and the two would cross with no connection between them.
   *
   * That is the same failure the editor's road tool avoids by calling
   * `splitEdge` when you click on an existing street, and it has to work the
   * same way here or a scripted city is quietly worse than a clicked one. It
   * showed up on the first generation as six `unreachable`/`no-exit` errors
   * around exactly the streets that join something mid-span.
   */
  at(x: number, y: number): number {
    const px = Math.round(x);
    const py = Math.round(y);
    const key = `${px},${py}`;
    const existing = this.junctions.get(key);
    if (existing !== undefined) return existing;

    const index = this.doc.addNode({ x: px, y: py });
    this.junctions.set(key, index);
    this.splitThrough(index, px, py);
    return index;
  }

  /**
   * Break every street that passes through a junction, so it joins there.
   *
   * Rescans from the top after each split because splitting rewrites the edge
   * list. A junction can sit on more than one street — a crossroads is exactly
   * that — so this keeps going until nothing else runs through the point.
   */
  private splitThrough(node: number, x: number, y: number): void {
    for (;;) {
      const city = this.doc.city;
      let target = -1;

      for (let i = 0; i < city.edges.length; i += 1) {
        const edge = city.edges[i]!;
        if (edge.a === node || edge.b === node) continue;
        const a = city.nodes[edge.a]!;
        const b = city.nodes[edge.b]!;
        if (!onSegment(x, y, a, b)) continue;
        target = i;
        break;
      }
      if (target === -1) return;

      const edge = city.edges[target]!;
      const { a, b, ...rest } = edge;
      this.doc.removeEdge(target);
      for (const [from, to] of [
        [a, node],
        [node, b],
      ] as const) {
        try {
          this.doc.addEdge({ a: from, b: to, ...rest });
        } catch {
          // Already joined by another street coming the other way.
        }
      }
    }
  }

  /**
   * A street through a list of points.
   *
   * Duplicate segments are skipped rather than thrown, because streets
   * genuinely do overlap at their ends and an authoring script should not have
   * to track which pairs it has already joined.
   */
  street(points: readonly (readonly [number, number])[], options: StreetOptions = {}): void {
    const width = options.width ?? 8;
    const name = options.name === undefined ? undefined : this.doc.addName(options.name);

    for (let i = 0; i < points.length - 1; i += 1) {
      const a = this.at(...points[i]!);
      const b = this.at(...points[i + 1]!);
      if (a === b) continue;
      try {
        this.doc.addEdge({
          a,
          b,
          width,
          ...(options.oneWay === true ? { flags: EdgeFlags.OneWay } : {}),
        });
      } catch {
        // Already connected — two streets meeting along a shared stretch.
      }
    }

    if (name !== undefined) {
      // Name the junctions along the street, for W-06's signage. The first
      // version of this called moveNode with the coordinates the node already
      // had, which is a no-op — so eight street names sat in the table with
      // nothing referencing them and every sign in the city would have been
      // blank. `unused-name` in audit.ts is the rule that now catches it.
      for (const [x, y] of points) {
        const index = this.at(x, y);
        if (this.doc.city.nodes[index]!.name === undefined) this.doc.nameNode(index, name);
      }
    }
  }

  /** A rectangle of collidable geometry. Ignored if it would be degenerate. */
  block(minX: number, minY: number, maxX: number, maxY: number): void {
    if (maxX - minX < 1 || maxY - minY < 1) return;
    this.doc.addBuilding({
      minX: Math.round(minX),
      minY: Math.round(minY),
      maxX: Math.round(maxX),
      maxY: Math.round(maxY),
    });
  }

  /**
   * Fill a city block, inset from the streets that bound it.
   *
   * The inset is what leaves room for a pavement — and for the kerb that
   * {@link snapKerb} places passengers on. Too small and passengers stand
   * inside buildings; `audit` reports that, but it is easier to leave the room
   * than to chase the findings.
   */
  fill(minX: number, minY: number, maxX: number, maxY: number, inset = 14): void {
    this.block(minX + inset, minY + inset, maxX - inset, maxY - inset);
  }

  /**
   * Put a junction wherever two streets cross.
   *
   * Authoring declares streets; this guarantees they *meet*. Without it the
   * Crease sails over the Yards grid like an overpass — and there is no
   * elevation in a 2D sim, so what that really means is two roads occupying the
   * same ground with no way to turn between them. It looks completely normal on
   * the map and drives like a wall.
   *
   * Every crossing is welded, with no notion of a bridge, because the city
   * format has no notion of one either. The `crossing-without-junction` rule in
   * `audit.ts` is what found the five this missed when it was done by hand.
   *
   * Terminates because splitting an edge at a point already on it subdivides
   * rather than adds geometry: the set of crossings is fixed up front, and each
   * pass resolves one.
   */
  weld(): void {
    for (;;) {
      const city = this.doc.city;
      let found: { x: number; y: number } | null = null;

      outer: for (let i = 0; i < city.edges.length; i += 1) {
        for (let j = i + 1; j < city.edges.length; j += 1) {
          const p = city.edges[i]!;
          const q = city.edges[j]!;
          if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue;

          const at = crossing(
            city.nodes[p.a]!,
            city.nodes[p.b]!,
            city.nodes[q.a]!,
            city.nodes[q.b]!,
          );
          if (at !== null) {
            found = at;
            break outer;
          }
        }
      }

      if (found === null) return;
      this.at(found.x, found.y);
    }
  }

  /**
   * Fill everything the streets do not use with buildings.
   *
   * Buildings are **derived from the street layout**, not authored beside it.
   * That is the whole point: hand-placed rectangles cannot hug a 45° avenue, so
   * the first version of City 01 had the Crease running through eight Ledger
   * blocks and twenty-seven roads through buildings city-wide. It looked
   * perfectly normal and was substantially impassable.
   *
   * Carving also produces the asymmetry `W-03` asks for without anyone
   * arranging it: block shape follows street shape, so the Ledger comes out
   * tight and regular, the Spine broad, and the Warrens irregular, because that
   * is what their streets are.
   *
   * The rasterise-and-merge is deliberately simple. A cell is dropped if any
   * carriageway comes within `pavement` of it; the survivors are merged
   * greedily into maximal rectangles, which keeps the building count in the
   * hundreds rather than the thousands.
   */
  carve(options: {
    readonly bounds: readonly [number, number, number, number];
    readonly cell?: number;
    readonly pavement?: number;
    /**
     * Largest a merged block may get, in cells, on either axis.
     *
     * Without a cap the merge is *maximal*, and a long corridor between two
     * parallel streets becomes a single building hundreds of units long. It
     * collides correctly and looks absurd: `W-05` draws every block as one
     * folded flap with one crease, so a 900-unit block is one 900-unit fold.
     * Capping keeps blocks building-sized, which is also what makes a district
     * read as a district rather than as a slab.
     */
    readonly maxCells?: number;
    /** Regions to leave empty — squares, plazas, the mouth of a bridge. */
    readonly keepClear?: readonly CityBox[];
  }): void {
    const cell = options.cell ?? 16;
    const pavement = options.pavement ?? 6;
    const maxCells = options.maxCells ?? 4;
    const [minX, minY, maxX, maxY] = options.bounds;
    const keepClear = options.keepClear ?? [];

    const cols = Math.ceil((maxX - minX) / cell);
    const rows = Math.ceil((maxY - minY) / cell);

    const city = this.doc.city;
    const roads = city.edges
      .map((e) => ({ a: city.nodes[e.a]!, b: city.nodes[e.b]!, reach: e.width / 2 + pavement }))
      .filter((r) => r.a !== undefined && r.b !== undefined);

    // free[row][col]
    const free: boolean[][] = [];
    for (let row = 0; row < rows; row += 1) {
      const line: boolean[] = [];
      for (let col = 0; col < cols; col += 1) {
        const box: CityBox = {
          minX: minX + col * cell,
          minY: minY + row * cell,
          maxX: Math.min(maxX, minX + (col + 1) * cell),
          maxY: Math.min(maxY, minY + (row + 1) * cell),
        };
        const blocked =
          roads.some((r) => segmentTouchesBox(r.a, r.b, box, r.reach)) ||
          keepClear.some((k) => boxesOverlap(box, k));
        line.push(!blocked);
      }
      free.push(line);
    }

    // Greedy maximal rectangles over the free cells.
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        if (!free[row]![col]) continue;

        let width = 0;
        while (col + width < cols && width < maxCells && free[row]![col + width]) width += 1;

        let height = 1;
        grow: while (row + height < rows && height < maxCells) {
          for (let k = 0; k < width; k += 1) {
            if (!free[row + height]![col + k]) break grow;
          }
          height += 1;
        }

        for (let r = 0; r < height; r += 1) {
          for (let c = 0; c < width; c += 1) free[row + r]![col + c] = false;
        }

        this.block(
          minX + col * cell,
          minY + row * cell,
          Math.min(maxX, minX + (col + width) * cell),
          Math.min(maxY, minY + (row + height) * cell),
        );
      }
    }
  }

  landmark(x: number, y: number, name: string): void {
    this.doc.addLandmark({ x, y, name: this.doc.addName(name) });
  }

  demand(x: number, y: number, radius: number, phase: number): void {
    this.doc.addDemandAnchor({ x, y, radius, phase });
  }

  /** A passenger point, placed on the kerb of whatever street is nearest. */
  kerb(x: number, y: number, kind: 'spawn' | 'destination'): CityPoint | null {
    const snapped = snapKerb(this.doc.city, { x, y }, kind);
    if (!snapped.onKerb) return null;
    return snapped.point;
  }

  get city(): CityJson {
    return this.doc.city;
  }
}

/**
 * Is a point on a segment, strictly between its ends?
 *
 * A whole-unit tolerance, because everything here is authored on integers and a
 * junction one hundredth of a unit off the line is a junction that should have
 * been on it.
 */
function onSegment(
  x: number,
  y: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return false;

  const t = ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared;
  // Strictly between: touching an end is not a split, it is the same junction.
  if (t <= 0.001 || t >= 0.999) return false;

  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)) <= 1;
}

/** Does a carriageway of the given reach touch a box? Slab clip, as in `audit`. */
function segmentTouchesBox(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: CityBox,
  reach: number,
): boolean {
  const minX = box.minX - reach;
  const minY = box.minY - reach;
  const maxX = box.maxX + reach;
  const maxY = box.maxY + reach;

  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  for (const [p, q] of [
    [-dx, a.x - minX],
    [dx, maxX - a.x],
    [-dy, a.y - minY],
    [dy, maxY - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t0 < t1;
}

function boxesOverlap(a: CityBox, b: CityBox): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/** Where two segments cross, strictly inside both, or `null`. */
function crossing(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  q1: { x: number; y: number },
  q2: { x: number; y: number },
): { x: number; y: number } | null {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = q2.x - q1.x;
  const sy = q2.y - q1.y;

  const denominator = rx * sy - ry * sx;
  if (denominator === 0) return null;

  const t = ((q1.x - p1.x) * sy - (q1.y - p1.y) * sx) / denominator;
  const u = ((q1.x - p1.x) * ry - (q1.y - p1.y) * rx) / denominator;
  const inside = (v: number): boolean => v > 0.001 && v < 0.999;
  if (!inside(t) || !inside(u)) return null;

  return { x: p1.x + t * rx, y: p1.y + t * ry };
}

/** Does a point fall inside any of these boxes? */
export function insideAny(point: { x: number; y: number }, boxes: readonly CityBox[]): boolean {
  return boxes.some(
    (b) => point.x >= b.minX && point.x <= b.maxX && point.y >= b.minY && point.y <= b.maxY,
  );
}
