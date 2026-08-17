/**
 * `render/scene.ts` — the layer order, and the culling that makes it cheap.
 *
 * One frame is a fixed sequence of layers, drawn back to front. The order is
 * not adjustable at runtime and is not a parameter: it is the drawing, and a
 * renderer whose layer order can vary is one whose output can vary.
 *
 * ```
 *   ground     pre-rendered chunks, blitted    (chunks.ts)
 *   markings   lane lines, crossings
 *   props      kerbs, planters, signage        (W-06)
 *   shadows    one soft ellipse per body
 *   traffic    NPC vehicles                    (S-08)
 *   cars       player cabs                     (S-06)
 *   pickups    waiting and carried passengers  (S-09)
 *   particles  skid puffs, delivery bursts     (C-08)
 *   overlay    meter, fare, deadhead clock     (C-05)
 * ```
 *
 * ## Why the counting is built in rather than bolted on
 *
 * `C-04`'s done-when is *"culling verified by a draw-call counter"*. A counter
 * added afterwards measures whatever it happens to wrap; a counter the layers
 * report to measures what they actually decided. So every layer reports two
 * numbers — how many candidates it looked at, and how many it drew — and the
 * ratio between them **is** the proof that culling works. A layer that draws
 * everything it considers is a layer that is not culling, and that shows up
 * here as a number rather than as a frame-rate mystery three weeks later.
 *
 * These counts are what `C-06` puts on screen. They are also the reason the
 * culling tests below can assert against a whole frame rather than against
 * individual predicates.
 *
 * ## Nothing here is deterministic, and that is fine
 *
 * The renderer reads the world and never writes it. Floats everywhere,
 * `Math.sin` wherever convenient, wall-clock time if a layer wants it. None of
 * it is hashed, sent or replayed — which is exactly why the sim's discipline
 * (ADR 0003, ADR 0004) can stop at the package boundary without leaking.
 */
import {
  Car,
  CarFlags,
  FX_ONE,
  MAX_PASSENGERS,
  MAX_TRAFFIC,
  NO_CARRIER,
  Passenger,
  PassengerFlags,
  Traffic,
  TrafficFlags,
  getCar,
  getPassenger,
  getPlayerCount,
  getTraffic,
  type World,
} from '@deadhead/sim';

import { lerpPose, shouldInterpolate, type Pose } from './interp.js';
import { containsPoint, visibleBounds, type Bounds, type ViewportState } from './viewport.js';

/** The layers, back to front. Index order is draw order. */
export const LAYERS = [
  'ground',
  'markings',
  'props',
  'shadows',
  'traffic',
  'cars',
  'pickups',
  'particles',
  'overlay',
] as const;

export type Layer = (typeof LAYERS)[number];

/** What one layer did this frame. */
export interface LayerCount {
  /** Candidates the layer looked at. */
  considered: number;
  /** Candidates it actually drew. */
  drawn: number;
}

export type FrameStats = Record<Layer, LayerCount>;

export function emptyFrameStats(): FrameStats {
  const stats = {} as FrameStats;
  for (const layer of LAYERS) stats[layer] = { considered: 0, drawn: 0 };
  return stats;
}

/**
 * Cull margins per layer, in world units.
 *
 * Each is the largest radius anything in that layer can have. Too small and
 * things pop in at the edge of the screen; too large and the cull stops paying
 * for itself. They are stated here, together, because they are a property of
 * the art rather than of any one layer's code.
 */
export const CullMargins = {
  /** A cab is about 4 units long, so 3 clears its corner under any rotation. */
  cars: 3,
  traffic: 3,
  /** A passenger marker plus its bobbing arrow. */
  pickups: 2.5,
  /** Shadows sit under bodies and are never larger than them. */
  shadows: 3,
  /** Props are authored per city; the largest in `W-03` is a planter. */
  props: 4,
  /** Particles are small but fast — a generous margin costs nothing. */
  particles: 2,
} as const;

/**
 * A drawable entity, resolved from the sim and interpolated for this frame.
 *
 * The renderer works on these rather than on raw world offsets so that culling,
 * sorting and drawing are all testable without a canvas.
 */
export interface Drawable {
  readonly slot: number;
  readonly pose: Pose;
  /** Raw flags word, for per-entity styling (a cab that is carrying, etc). */
  readonly flags: number;
}

/**
 * Every player cab worth drawing this frame.
 *
 * Interpolates between the two sim states, skips cabs that are not active, and
 * culls against the view. A cab that teleported — a respawn (`G-01`) or a hard
 * correction (`M-06`) — is snapped to its current state rather than slid across
 * the city over one frame.
 */
export function visibleCars(
  previous: World,
  current: World,
  view: ViewportState,
  alpha: number,
  count: LayerCount,
): Drawable[] {
  const bounds = visibleBounds(view, CullMargins.cars);
  const out: Drawable[] = [];
  const players = getPlayerCount(current);

  for (let slot = 0; slot < players; slot += 1) {
    // There is no "active" bit on a cab. A slot is live if it is inside
    // `playerCount`, and an eliminated cab (deadhead clock hit zero, and it is
    // final — see CarFlags.Eliminated) is off the board entirely.
    const flags = getCar(current, slot, Car.Flags);
    if ((flags & CarFlags.Eliminated) !== 0) continue;
    count.considered += 1;

    const pose = poseOf(previous, current, slot, alpha, readCar);
    if (!containsPoint(bounds, pose.x, pose.y, CullMargins.cars)) continue;

    count.drawn += 1;
    out.push({ slot, pose, flags });
  }

  return out;
}

/** NPC vehicles (`S-08`). Same shape as {@link visibleCars}, different table. */
export function visibleTraffic(
  previous: World,
  current: World,
  view: ViewportState,
  alpha: number,
  count: LayerCount,
): Drawable[] {
  const bounds = visibleBounds(view, CullMargins.traffic);
  const out: Drawable[] = [];

  for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) {
    const flags = getTraffic(current, slot, Traffic.Flags);
    if ((flags & TrafficFlags.Active) === 0) continue;
    count.considered += 1;

    const pose = poseOf(previous, current, slot, alpha, readTraffic);
    if (!containsPoint(bounds, pose.x, pose.y, CullMargins.traffic)) continue;

    count.drawn += 1;
    out.push({ slot, pose, flags });
  }

  return out;
}

/**
 * Passengers waiting to be picked up.
 *
 * Carried passengers are deliberately excluded: they are inside a cab and the
 * cab layer draws them. Drawing them here too would put a marker on the roof.
 */
export function visiblePassengers(
  current: World,
  view: ViewportState,
  count: LayerCount,
): Drawable[] {
  const bounds = visibleBounds(view, CullMargins.pickups);
  const out: Drawable[] = [];

  for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
    const flags = getPassenger(current, slot, Passenger.Flags);
    if ((flags & PassengerFlags.Active) === 0) continue;
    // "Carried" is not a flag — it is the Carrier field pointing at a cab. A
    // carried passenger is inside a cab and the cars layer draws them; drawing
    // them here too would put a marker on the roof.
    if (getPassenger(current, slot, Passenger.Carrier) !== NO_CARRIER) continue;
    count.considered += 1;

    // Passengers do not move while waiting, so there is nothing to interpolate.
    const x = getPassenger(current, slot, Passenger.X) / FX_ONE;
    const y = getPassenger(current, slot, Passenger.Y) / FX_ONE;
    if (!containsPoint(bounds, x, y, CullMargins.pickups)) continue;

    count.drawn += 1;
    out.push({ slot, pose: { x, y, heading: 0 }, flags });
  }

  return out;
}

/** Reads one entity's raw pose fields out of a world. */
type PoseReader = (
  world: World,
  slot: number,
) => { x: number; y: number; heading: number };

const readCar: PoseReader = (world, slot) => ({
  x: getCar(world, slot, Car.X),
  y: getCar(world, slot, Car.Y),
  heading: getCar(world, slot, Car.Heading),
});

const readTraffic: PoseReader = (world, slot) => ({
  x: getTraffic(world, slot, Traffic.X),
  y: getTraffic(world, slot, Traffic.Y),
  heading: getTraffic(world, slot, Traffic.Heading),
});

/**
 * Interpolate one entity, or snap it if it teleported.
 *
 * The teleport check is not an optimisation. Sliding a cab across the city over
 * a single frame — which is what interpolating a respawn looks like — is far
 * more jarring than the snap it replaces.
 */
function poseOf(
  previous: World,
  current: World,
  slot: number,
  alpha: number,
  read: PoseReader,
): Pose {
  const before = read(previous, slot);
  const after = read(current, slot);

  if (!shouldInterpolate(before, after)) {
    return { x: after.x / FX_ONE, y: after.y / FX_ONE, heading: after.heading & 0xffff };
  }
  return lerpPose(before, after, alpha);
}

/**
 * Total draw calls across every layer — the single number `C-06` shows.
 *
 * Reported alongside `considered` rather than instead of it: the interesting
 * quantity is the *ratio*. Twelve drawn out of twelve considered means the
 * cull is doing nothing, and that is invisible in a total.
 */
export function totalDrawn(stats: FrameStats): number {
  let total = 0;
  for (const layer of LAYERS) total += stats[layer].drawn;
  return total;
}

/** Total candidates examined across every layer. */
export function totalConsidered(stats: FrameStats): number {
  let total = 0;
  for (const layer of LAYERS) total += stats[layer].considered;
  return total;
}

/**
 * The fraction of candidates that survived culling, in `[0, 1]`.
 *
 * The number that answers "is culling working". On `W-03`'s city with a cab in
 * one corner this should sit well below 1; at 1 the cull has stopped doing
 * anything and the frame budget is about to become a problem.
 */
export function cullRatio(stats: FrameStats): number {
  const considered = totalConsidered(stats);
  return considered === 0 ? 0 : totalDrawn(stats) / considered;
}

/** Bounds of a drawable, for tests and for `W-02`'s picking. */
export function drawableBounds(drawable: Drawable, radius: number): Bounds {
  return {
    minX: drawable.pose.x - radius,
    minY: drawable.pose.y - radius,
    maxX: drawable.pose.x + radius,
    maxY: drawable.pose.y + radius,
  };
}
