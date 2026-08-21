/**
 * `collide.ts` — static collision.
 *
 * Cabs collide with the city, and with nothing else. **There is no
 * player-versus-player collision in v1** (`DESIGN.md` §2.3): contests are
 * decided by positioning and braking, not by shoving, and removing car-car
 * contact removes the single worst thing to have to predict and reconcile in
 * `M-06`.
 *
 * ## Shape of the problem
 *
 * The city is axis-aligned boxes. The cab is an *oriented* box — it has a
 * heading, and at speed it points somewhere other than where it is going, which
 * is the whole of `S-06`. So the narrowphase is AABB-versus-oriented-box, by
 * separating axis, over four axes.
 *
 * ## Staying inside the arithmetic bound
 *
 * ADR 0003: `fxMul` overflows above ±181 units, so **squaring or multiplying an
 * absolute coordinate is not allowed** — a map-corner distance is 32x past it.
 * Everything below multiplies only:
 *
 * - half-extents (a few units) by a sine or cosine (at most 1), and
 * - a *relative* centre-to-centre offset by a sine or cosine.
 *
 * The second one is only small because the broadphase has already discarded
 * everything not in a neighbouring cell. That is not merely an optimisation
 * here; it is what keeps the narrowphase arithmetic legal. A "let me just test
 * every box" shortcut would overflow silently on distant geometry.
 *
 * ## Tunnelling
 *
 * A cab moves about one unit per tick at top speed and is a couple of units
 * long, so it cannot currently tunnel through a wall. That is a property of the
 * *current tuning*, not of the design, and `C-06`'s sliders exist precisely to
 * change it. The sweep below subdivides movement into whole substeps sized so a
 * cab can never jump more than half its own width, which costs nothing at normal
 * speed (one substep) and does not have to be remembered later.
 */
import { CarTuning } from './car.js';
import { WORLD_MIN } from './constants.js';
import { fxAbs, fxFloorToInt, fxMul, fxCos, fxSin, fxFromInt } from './fx.js';
import { Car, CarFlags, getCar, setCar, type World } from './world.js';

/** `[minX, minY, maxX, maxY]` per box, 16.16. */
const BOX_STRIDE = 4;

/**
 * Static city geometry, prepared for lookup.
 *
 * Like the city data it comes from, this is an **input** to the sim rather than
 * state: it never changes during a run, so it is not copied, not serialised and
 * not hashed. It hangs off {@link World} beside `data` — see ADR 0004.
 */
export interface StaticGeometry {
  /** Box bounds, `BOX_STRIDE` entries each, 16.16. */
  readonly boxes: Int32Array;
  /** Cell size as a power-of-two count of whole units. */
  readonly cellShift: number;
  /** Cells along each axis. */
  readonly gridDim: number;
  /** CSR offsets into {@link cellItems}, length `gridDim * gridDim + 1`. */
  readonly cellStart: Int32Array;
  /** Box indices, grouped by cell. */
  readonly cellItems: Int32Array;
}

/** Result of resolving one cab's movement. */
export interface CollisionResult {
  /** True if the cab touched anything this tick. */
  readonly hit: boolean;
  /** Speed lost to the impact, in units per tick. `G-01` turns this into a crash penalty. */
  readonly impact: number;
}

const NO_COLLISION: CollisionResult = { hit: false, impact: 0 };

/**
 * Build the lookup structure.
 *
 * Uses CSR — a prefix-summed offset array plus a flat index array — rather than
 * a map of arrays, because iteration order has to be identical everywhere. A
 * `Map` iterating in insertion order would *happen* to be deterministic; a flat
 * array is deterministic by construction and needs no argument.
 *
 * @param boxes flat `[minX, minY, maxX, maxY]` in 16.16
 * @param cellShift log2 of the cell size in whole units. The default of 5 gives
 *   32-unit cells: small enough to keep narrowphase offsets far inside the
 *   arithmetic bound, large enough that a city's worth of walls stays cheap.
 */
export function buildStaticGeometry(boxes: Int32Array, cellShift = 5): StaticGeometry {
  const count = Math.floor(boxes.length / BOX_STRIDE);
  const gridDim = Math.max(1, (-WORLD_MIN * 2) >> cellShift);
  const cellCount = gridDim * gridDim;

  const cellStart = new Int32Array(cellCount + 1);

  // Count, prefix-sum, fill: two passes and no intermediate allocation per cell.
  const spans: number[] = [];
  for (let box = 0; box < count; box += 1) {
    const base = box * BOX_STRIDE;
    const x0 = cellIndexOnAxis(boxes[base], cellShift, gridDim);
    const y0 = cellIndexOnAxis(boxes[base + 1], cellShift, gridDim);
    const x1 = cellIndexOnAxis(boxes[base + 2], cellShift, gridDim);
    const y1 = cellIndexOnAxis(boxes[base + 3], cellShift, gridDim);
    spans.push(x0, y0, x1, y1);
    for (let cy = y0; cy <= y1; cy += 1) {
      for (let cx = x0; cx <= x1; cx += 1) cellStart[cy * gridDim + cx + 1] += 1;
    }
  }
  for (let cell = 0; cell < cellCount; cell += 1) cellStart[cell + 1] += cellStart[cell];

  const cellItems = new Int32Array(cellStart[cellCount]);
  const cursor = Int32Array.from(cellStart.subarray(0, cellCount));
  for (let box = 0; box < count; box += 1) {
    const [x0, y0, x1, y1] = spans.slice(box * 4, box * 4 + 4) as [number, number, number, number];
    for (let cy = y0; cy <= y1; cy += 1) {
      for (let cx = x0; cx <= x1; cx += 1) {
        const cell = cy * gridDim + cx;
        cellItems[cursor[cell]] = box;
        cursor[cell] += 1;
      }
    }
  }

  return { boxes, cellShift, gridDim, cellStart, cellItems };
}

function cellIndexOnAxis(coordinate: number, cellShift: number, gridDim: number): number {
  const cell = (fxFloorToInt(coordinate) - WORLD_MIN) >> cellShift;
  if (cell < 0) return 0;
  return cell >= gridDim ? gridDim - 1 : cell;
}

/**
 * True if an oriented box centred at `(x, y)` overlaps any static box.
 *
 * Separating-axis test over four axes: the two world axes and the two axes of
 * the oriented box. Any axis on which the projections do not overlap proves
 * separation, so the first such axis exits early.
 */
export function overlapsStatic(
  geometry: StaticGeometry,
  x: number,
  y: number,
  heading: number,
  halfLength: number,
  halfWidth: number,
): boolean {
  const cos = fxAbs(fxCos(heading));
  const sin = fxAbs(fxSin(heading));

  // Extent of the oriented box projected onto each world axis. Both operands
  // are small: a half-extent by a value at most 1.0.
  const spanX = fxMul(halfLength, cos) + fxMul(halfWidth, sin);
  const spanY = fxMul(halfLength, sin) + fxMul(halfWidth, cos);

  const minCellX = cellIndexOnAxis(x - spanX, geometry.cellShift, geometry.gridDim);
  const maxCellX = cellIndexOnAxis(x + spanX, geometry.cellShift, geometry.gridDim);
  const minCellY = cellIndexOnAxis(y - spanY, geometry.cellShift, geometry.gridDim);
  const maxCellY = cellIndexOnAxis(y + spanY, geometry.cellShift, geometry.gridDim);

  const axisCos = fxCos(heading);
  const axisSin = fxSin(heading);

  for (let cy = minCellY; cy <= maxCellY; cy += 1) {
    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      const cell = cy * geometry.gridDim + cx;
      for (let i = geometry.cellStart[cell]; i < geometry.cellStart[cell + 1]; i += 1) {
        const base = geometry.cellItems[i] * BOX_STRIDE;

        const boxMinX = geometry.boxes[base];
        const boxMinY = geometry.boxes[base + 1];
        const boxMaxX = geometry.boxes[base + 2];
        const boxMaxY = geometry.boxes[base + 3];

        // Half-extents and centre of the static box, then the offset between
        // centres. The offset is small *because the broadphase ran* — that is
        // what keeps the multiplies below inside the ±181 bound.
        const halfX = (boxMaxX - boxMinX) >> 1;
        const halfY = (boxMaxY - boxMinY) >> 1;
        const dx = x - (boxMinX + halfX);
        const dy = y - (boxMinY + halfY);

        if (fxAbs(dx) > halfX + spanX) continue;
        if (fxAbs(dy) > halfY + spanY) continue;

        // Now the cab's own axes. Project the static box's half-extents onto
        // them; the cab projects to exactly its own half-extents.
        const boxSpanAlong = fxMul(halfX, fxAbs(axisCos)) + fxMul(halfY, fxAbs(axisSin));
        const boxSpanAcross = fxMul(halfX, fxAbs(axisSin)) + fxMul(halfY, fxAbs(axisCos));

        const along = fxMul(dx, axisCos) + fxMul(dy, axisSin);
        const across = fxMul(dy, axisCos) - fxMul(dx, axisSin);

        if (fxAbs(along) > halfLength + boxSpanAlong) continue;
        if (fxAbs(across) > halfWidth + boxSpanAcross) continue;

        return true;
      }
    }
  }

  return false;
}

/**
 * Move a cab from its previous position to its new one, stopping at whatever it
 * runs into.
 *
 * Resolution is **axis-separated**: if the combined move is blocked, the move is
 * retried on each axis alone. That gives sliding along a wall for free and, more
 * importantly, is *stable* — a cab held against a wall lands on exactly the same
 * position every tick with its into-wall velocity zeroed, so it rests rather
 * than jittering. Reflecting the velocity instead would buzz.
 *
 * @returns whether anything was hit, and how much speed the impact cost.
 */
export function sweepCar(
  world: World,
  slot: number,
  geometry: StaticGeometry,
  fromX: number,
  fromY: number,
): CollisionResult {
  const targetX = getCar(world, slot, Car.X);
  const targetY = getCar(world, slot, Car.Y);
  const heading = getCar(world, slot, Car.Heading) & 0xffff;

  const { halfLength, halfWidth } = CarTuning;

  const deltaX = targetX - fromX;
  const deltaY = targetY - fromY;

  // Substep count from Chebyshev distance — deliberately not Euclidean, which
  // would need a square root or a squared magnitude, and a squared magnitude of
  // a *displacement* is fine but the max-of-abs is exact and cheaper.
  const reach = Math.max(fxAbs(deltaX), fxAbs(deltaY));
  const maxStep = halfWidth > 0 ? halfWidth : 1;
  const substeps = 1 + Math.floor(reach / maxStep);

  const stepX = (deltaX / substeps) | 0;
  const stepY = (deltaY / substeps) | 0;

  let x = fromX;
  let y = fromY;
  let blockedX = false;
  let blockedY = false;

  for (let i = 1; i <= substeps; i += 1) {
    // The final substep lands exactly on the target rather than on the
    // accumulation of truncated steps, so an unobstructed sweep is a no-op.
    const nextX = i === substeps && !blockedX ? targetX : x + stepX;
    const nextY = i === substeps && !blockedY ? targetY : y + stepY;

    const wantX = blockedX ? x : nextX;
    const wantY = blockedY ? y : nextY;

    if (!overlapsStatic(geometry, wantX, wantY, heading, halfLength, halfWidth)) {
      x = wantX;
      y = wantY;
      continue;
    }

    // Blocked together — try each axis alone, which is what produces sliding.
    if (!blockedX && !overlapsStatic(geometry, wantX, y, heading, halfLength, halfWidth)) {
      x = wantX;
      blockedY = true;
    } else if (!blockedY && !overlapsStatic(geometry, x, wantY, heading, halfLength, halfWidth)) {
      y = wantY;
      blockedX = true;
    } else {
      blockedX = true;
      blockedY = true;
      break;
    }
  }

  if (!blockedX && !blockedY) return NO_COLLISION;

  // Wedged: nothing moved, on either axis. That is normal against a wall — but
  // it is *permanent* if the cab began the tick already overlapping, because
  // every candidate position overlaps too and there is nothing here that can
  // reduce an overlap.
  //
  // A cab gets into that state by **rotating**. Only translation is checked
  // against geometry; heading is applied unconditionally, so a cab resting
  // flush against a wall that steers sweeps a corner in by a fraction of a
  // unit. Found in City 01: a cab penetrating a building by 0.017 units sat
  // motionless for the rest of the run, holding brake, velocity exactly zero.
  //
  // So when — and only when — the sweep achieved nothing and the starting pose
  // is invalid, push the cab back out. See {@link pushOut}.
  if (blockedX && blockedY && overlapsStatic(geometry, x, y, heading, halfLength, halfWidth)) {
    const freed = pushOut(geometry, x, y, heading, halfLength, halfWidth);
    if (freed !== null) {
      x = freed.x;
      y = freed.y;
    }
  }

  const lostX = blockedX ? getCar(world, slot, Car.VelocityX) : 0;
  const lostY = blockedY ? getCar(world, slot, Car.VelocityY) : 0;

  setCar(world, slot, Car.X, x);
  setCar(world, slot, Car.Y, y);
  if (blockedX) setCar(world, slot, Car.VelocityX, 0);
  if (blockedY) setCar(world, slot, Car.VelocityY, 0);

  const impact = Math.max(fxAbs(lostX), fxAbs(lostY));
  if (impact >= CarTuning.crashImpact) {
    setCar(world, slot, Car.Flags, getCar(world, slot, Car.Flags) | CarFlags.Crashed);
  }

  return { hit: true, impact };
}

/**
 * How far out to look for clear ground, in whole units.
 *
 * Overlaps only ever arise from a rotation sweeping a corner in, so they are a
 * fraction of a unit deep and the first probe almost always succeeds. The cap
 * exists so a cab that has somehow ended up deep inside geometry gives up
 * rather than scanning the map.
 */
const PUSH_OUT_LIMIT = 4;

/**
 * The nearest pose clear of geometry, or `null` if there is none nearby.
 *
 * Probes the four axis directions at whole-unit distances, nearest first. Axis
 * order is fixed and the search is integer throughout, so two machines agree —
 * this runs inside `step()` and anything here is replayed (ADR 0004).
 *
 * Deliberately **not** a true minimum-translation-vector: computing exact
 * penetration depth for an oriented box against an AABB needs SAT with depth,
 * and this is a recovery path from a state that should be a fraction of a unit
 * deep. The nearest clear whole unit is close enough and much easier to be sure
 * is deterministic.
 */
function pushOut(
  geometry: StaticGeometry,
  x: number,
  y: number,
  heading: number,
  halfLength: number,
  halfWidth: number,
): { readonly x: number; readonly y: number } | null {
  for (let distance = 1; distance <= PUSH_OUT_LIMIT; distance += 1) {
    const offset = fxFromInt(distance);
    // Fixed order: +y, -y, +x, -x. Arbitrary, but identical everywhere.
    const candidates: readonly (readonly [number, number])[] = [
      [x, y + offset],
      [x, y - offset],
      [x + offset, y],
      [x - offset, y],
    ];
    for (const [cx, cy] of candidates) {
      if (!overlapsStatic(geometry, cx, cy, heading, halfLength, halfWidth)) {
        return { x: cx, y: cy };
      }
    }
  }
  return null;
}

/** An empty city, for tests and for a run that has not loaded one yet. */
export function emptyGeometry(): StaticGeometry {
  return buildStaticGeometry(new Int32Array(0));
}

/** Convenience for authoring boxes in whole units. */
export function boxesFromUnits(boxes: readonly (readonly number[])[]): Int32Array {
  const flat = new Int32Array(boxes.length * BOX_STRIDE);
  boxes.forEach((box, index) => {
    for (let i = 0; i < BOX_STRIDE; i += 1) flat[index * BOX_STRIDE + i] = fxFromInt(box[i] ?? 0);
  });
  return flat;
}
