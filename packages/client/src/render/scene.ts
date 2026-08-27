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
  NO_PASSENGER,
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

import { type GroundCache } from './chunks.js';
import { cab, destination, landmark, passenger, posed } from './figures.js';
import { Ink } from './palette.js';
import { SHADOW_X, SHADOW_Y, type PaperContext } from './paper.js';
import { angleToRadians, lerpPose, shouldInterpolate, type Pose } from './interp.js';
import {
  applyCamera,
  containsPoint,
  visibleBounds,
  type Bounds,
  type ViewportState,
} from './viewport.js';

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
 *
 * **Applied exactly once**, as the radius argument to `containsPoint`, with
 * `visibleBounds` given no margin of its own. The first version passed the
 * margin to *both*, which silently doubled it: the documented 3-unit margin
 * behaved as 6, and the edge test passed either way because it probed x=52
 * when the real boundary had moved to x=56. Conservative, so nothing looked
 * wrong — but twice the stated value, and the test could not tell.
 */
export const CullMargins = {
  /**
   * A cab's half-diagonal, rounded up.
   *
   * `CarTuning.halfLength` is 1.1 and `halfWidth` is 0.5, so the cab is
   * 2.2 × 1.0 units and the furthest any corner sits from its centre is
   * `hypot(1.1, 0.5)` ≈ 1.21 — at any rotation. 1.5 clears that with room to
   * spare.
   *
   * The first version said 3, "because a cab is about 4 units long". It is not;
   * that number came from nowhere and was 2.5× more than needed, so every frame
   * drew a band of cabs that could not be seen. Read from `CarTuning` rather
   * than estimated, which is where the real answer was the whole time.
   */
  cars: 1.5,
  traffic: 1.5,
  /** A passenger marker plus its bobbing arrow. */
  pickups: 2.5,
  /** Shadows sit under bodies and are never larger than them. */
  shadows: 1.5,
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
  const bounds = visibleBounds(view);
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
  const bounds = visibleBounds(view);
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
  const bounds = visibleBounds(view);
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
type PoseReader = (world: World, slot: number) => { x: number; y: number; heading: number };

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

// ---------------------------------------------------------------------------
// The frame itself.
// ---------------------------------------------------------------------------

/**
 * The 2D context operations a frame uses.
 *
 * Declared structurally rather than as `CanvasRenderingContext2D` so a frame
 * can be rendered against a recording double in node. This is a narrowing that
 * pays: unlike a chunk surface — which must be a *real* canvas because
 * `drawImage` demands one — a context is only ever called, never handed to a
 * browser API, so a double that records calls is a complete stand-in.
 */
export interface FrameContext extends PaperContext {
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  /**
   * `unknown` rather than `CanvasImageSource` on purpose.
   *
   * The image is whatever `TSurface` the ground cache was built with — an
   * `OffscreenCanvas` in the browser, a double in a test — and `FrameContext`
   * is this renderer's own abstraction rather than a DOM type, so it should not
   * demand one. (`never` was the first attempt and is worse than useless here:
   * it makes the method uncallable by anyone, including the blit that is its
   * only caller.)
   */
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
  globalAlpha: number;
}

/** Everything one frame needs. Assembled by `main.ts`, never by a layer. */
export interface FrameInput<TSurface> {
  readonly previous: World;
  readonly current: World;
  readonly view: ViewportState;
  /** Interpolation fraction from `loop.ts`, in `[0, 1)`. */
  readonly alpha: number;
  /** The city, for the layers that draw authored points rather than sim state. */
  readonly cityJson?: {
    readonly destinations: readonly { readonly x: number; readonly y: number }[];
    readonly landmarks: readonly { readonly x: number; readonly y: number }[];
  };
  /**
   * The particle pool, if there is one. Omitted by `W-02`'s editor and by tests
   * that do not care — the layer draws nothing rather than requiring a stub.
   */
  readonly particles?: {
    draw(
      context: FrameContext,
      visible: (x: number, y: number) => boolean,
      posed: (x: number, y: number, angle: number, paint: () => void) => void,
    ): { considered: number; drawn: number };
  };
  /** The ground cache. Omitted by `W-02`'s editor, which draws its own ground. */
  readonly ground?: {
    readonly cache: GroundCache<TSurface>;
    /** Blits one prepared chunk. Kept out of here so the cache stays canvas-agnostic. */
    readonly blit: (context: FrameContext, surface: TSurface, bounds: Bounds) => void;
  };
}

/**
 * Draw one frame, in layer order, and report what each layer did.
 *
 * This is the only function that knows the order, and it iterates {@link LAYERS}
 * rather than hard-coding a sequence of calls — so a layer added to the array
 * and not handled here is a compile error rather than a layer that silently
 * never draws.
 *
 * The placeholder shapes are deliberate. `W-05` replaces every fill in here
 * with the real identity; what `C-04` owes is the *structure* — correct order,
 * correct culling, and a blit that actually reaches a canvas — so that `W-02`
 * has a renderer to reuse and `W-05` has somewhere to put the art.
 */
export function renderScene<TSurface>(
  context: FrameContext,
  input: FrameInput<TSurface>,
): FrameStats {
  const stats = emptyFrameStats();
  const { view } = input;

  context.save();
  context.clearRect(0, 0, view.width, view.height);
  applyCamera(context, view);

  for (const layer of LAYERS) {
    drawLayer(layer, context, input, stats);
  }

  context.restore();
  return stats;
}

/**
 * One layer.
 *
 * The `switch` is exhaustive over {@link Layer}; the `never` in the default
 * branch is what makes adding a layer to `LAYERS` without handling it fail to
 * compile, rather than fail silently at 60 fps.
 */
function drawLayer<TSurface>(
  layer: Layer,
  context: FrameContext,
  input: FrameInput<TSurface>,
  stats: FrameStats,
): void {
  const { previous, current, view, alpha } = input;

  switch (layer) {
    case 'ground': {
      const ground = input.ground;
      if (ground === undefined) return;
      const bounds = visibleBounds(view);
      ground.cache.beginFrame();
      for (const chunk of ground.cache.chunksIn(bounds)) {
        stats.ground.considered += 1;
        const surface = ground.cache.acquire(chunk.x, chunk.y);
        ground.blit(context, surface, ground.cache.boundsOf(chunk.x, chunk.y));
        stats.ground.drawn += 1;
      }
      ground.cache.endFrame();
      return;
    }

    case 'markings':
      // Road markings are creases, painted into the ground chunks by
      // `city.ts`. The slot stays because `W-06`'s signage will want it.
      return;

    case 'props': {
      // Landmarks and destinations: the only wayfinding in the game, since
      // DESIGN.md §2.4 rules out a floating arrow. Above the road, below the
      // cars, which is exactly why this layer sits where it does.
      const city = input.cityJson;
      if (city === undefined) return;

      const bounds = visibleBounds(view);
      context.lineWidth = 0.4;

      for (const point of city.destinations) {
        stats.props.considered += 1;
        if (!containsPoint(bounds, point.x, point.y, CullMargins.props)) continue;
        stats.props.drawn += 1;
        posed(context, point.x, point.y, 0, (ctx) => destination(ctx, 2.4));
      }
      for (const point of city.landmarks) {
        stats.props.considered += 1;
        if (!containsPoint(bounds, point.x, point.y, 14)) continue;
        stats.props.drawn += 1;
        posed(context, point.x, point.y, 0, (ctx) => landmark(ctx, 9));
      }
      return;
    }

    case 'shadows': {
      // Every moving thing drops the same shadow the buildings do, from the
      // same light (palette.ts). That is what keeps a cab on the sheet rather
      // than floating above it — and why the offset is imported rather than
      // written out here where it could drift.
      const scratch: LayerCount = { considered: 0, drawn: 0 };
      const cars = visibleCars(previous, current, view, alpha, stats.shadows);
      const traffic = visibleTraffic(previous, current, view, alpha, scratch);

      // A car sits ON the sheet, not lifted off it like a building, so its
      // shadow is a fraction of the building offset — and it turns with the
      // car. An axis-aligned shadow under a rotating body reads as a separate
      // object sliding around underneath it.
      const drop = 0.28;
      context.fillStyle = Ink.graphiteShadow;
      for (const body of [...traffic, ...cars]) {
        posed(
          context,
          body.pose.x + SHADOW_X * drop,
          body.pose.y + SHADOW_Y * drop,
          angleToRadians(body.pose.heading),
          (ctx) => {
            ctx.beginPath();
            ctx.moveTo(-1.1, -0.5);
            ctx.lineTo(1.1, -0.5);
            ctx.lineTo(1.1, 0.5);
            ctx.lineTo(-1.1, 0.5);
            ctx.closePath();
            ctx.fill();
          },
        );
      }
      return;
    }

    case 'traffic': {
      // NPCs are the same folded car, in ink. They are scenery, so they never
      // touch the accent — the only saturated thing on screen is the player.
      const traffic = visibleTraffic(previous, current, view, alpha, stats.traffic);
      context.lineWidth = 0.16;
      for (const npc of traffic) {
        posed(context, npc.pose.x, npc.pose.y, angleToRadians(npc.pose.heading), (ctx) =>
          cab(ctx, true),
        );
      }
      return;
    }

    case 'cars': {
      const cars = visibleCars(previous, current, view, alpha, stats.cars);
      context.lineWidth = 0.16;
      for (const car of cars) {
        // An empty cab is the accent; a carrying one goes quiet. ADR 0001
        // reserves the accent for motion and the empty-cab state, and an empty
        // cab is one burning its deadhead clock — so the screen is loud while
        // you are losing and calm while you are earning, which is the correct
        // way round and costs nothing to render.
        const carrying = getCar(current, car.slot, Car.CarriedPassenger) !== NO_PASSENGER;
        posed(context, car.pose.x, car.pose.y, angleToRadians(car.pose.heading), (ctx) =>
          cab(ctx, carrying),
        );
      }
      return;
    }

    case 'pickups': {
      const waiting = visiblePassengers(current, view, stats.pickups);
      context.lineWidth = 0.16;
      for (const person of waiting) {
        // Rush against Meter is told apart by posture and value, never by a
        // second hue — the accent is spoken for.
        const rush = (person.flags & PassengerFlags.Rush) !== 0;
        posed(context, person.pose.x, person.pose.y, 0, (ctx) => passenger(ctx, rush));
      }
      return;
    }

    case 'particles': {
      // Presentation only — never sim state, never hashed, never sent. The
      // pool arrives through `FrameInput` rather than being owned here, so the
      // renderer stays a pure function of what it is handed.
      const pool = input.particles;
      if (pool === undefined) return;
      const bounds = visibleBounds(view);
      const counts = pool.draw(
        context,
        (x, y) => containsPoint(bounds, x, y, CullMargins.particles),
        (x, y, angle, paint) => posed(context, x, y, angle, paint),
      );
      stats.particles.considered += counts.considered;
      stats.particles.drawn += counts.drawn;
      return;
    }

    case 'overlay':
      // C-05's HUD draws in screen space, after the camera is unwound. G-02
      // fills this in; the slot exists so nothing else can end up last.
      return;

    default: {
      const exhaustive: never = layer;
      throw new Error(`unhandled layer: ${String(exhaustive)}`);
    }
  }
}
