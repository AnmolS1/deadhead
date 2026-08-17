/**
 * `bot.ts` — a deterministic driver.
 *
 * Not an AI, and not trying to be good. It exists because a *recorded* input
 * log is only a useful golden if it actually plays the game: blind scripted
 * input almost never comes to a stop on a kerb, so a log written by hand
 * records a cab driving in circles and exercises none of the passenger, fare or
 * clock code that the golden is supposed to protect.
 *
 * It steers at whatever it currently wants — the nearest waiting passenger, or
 * the destination of whoever is aboard — throttles when far, and brakes when
 * close enough that stopping matters.
 *
 * **It follows the road network to get there.** The first version drove
 * straight at the target and wedged itself against a building within twenty
 * seconds, which produced golden logs containing one pickup and no deliveries —
 * exactly the code the goldens exist to protect, untested. Steering via a
 * breadth-first path over the nav graph keeps it on roads, which is where the
 * roads already are.
 *
 * `M-14`'s load-test bots are this, many times over.
 *
 * Everything here reads sim state and returns an input byte. It is *outside*
 * the sim, so it may use whole-unit arithmetic freely — and it must, because
 * distances between a cab and a destination are absolute-scale and squaring one
 * in 16.16 overflows (ADR 0003).
 */
import { Input } from '@deadhead/proto';
import {
  Car,
  FX_ONE,
  MAX_PASSENGERS,
  NO_CARRIER,
  NO_PASSENGER,
  Passenger,
  TURN,
  carSpeed,
  fxAtan2,
  fxFloorToInt,
  getCar,
  getPassenger,
  isPassengerActive,
  type RuntimeCity,
  type World,
} from '@deadhead/sim';

const POINT_WORDS = 4;
const NODE_WORDS = 3;

/** Whole units within which the bot considers itself "at" a waypoint. */
const WAYPOINT_UNITS = 10;

/** Whole units at which the bot starts braking, so it can stop inside a radius. */
const APPROACH_UNITS = 14;

/** Turn units of heading error above which the bot stops accelerating into the turn. */
const SHARP_TURN = TURN / 12;

/** What the bot is currently driving at, in 16.16, or null if it has no target. */
function target(world: World, city: RuntimeCity): { x: number; y: number } | null {
  const carried = getCar(world, 0, Car.CarriedPassenger);

  if (carried !== NO_PASSENGER) {
    const base = getPassenger(world, carried, Passenger.Destination) * POINT_WORDS;
    const destinations = city.packed.destinations;
    if (base < 0 || base >= destinations.length) return null;
    return { x: destinations[base] as number, y: destinations[base + 1] as number };
  }

  // Nearest waiting passenger by Chebyshev distance in whole units — no
  // squaring, so nothing can overflow at map scale.
  const carX = fxFloorToInt(getCar(world, 0, Car.X));
  const carY = fxFloorToInt(getCar(world, 0, Car.Y));
  let best = -1;
  let bestDistance = Number.MAX_SAFE_INTEGER;

  for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
    if (!isPassengerActive(world, slot)) continue;
    if (getPassenger(world, slot, Passenger.Carrier) !== NO_CARRIER) continue;

    const dx = Math.abs(fxFloorToInt(getPassenger(world, slot, Passenger.X)) - carX);
    const dy = Math.abs(fxFloorToInt(getPassenger(world, slot, Passenger.Y)) - carY);
    const distance = Math.max(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  }

  if (best < 0) return null;
  return {
    x: getPassenger(world, best, Passenger.X),
    y: getPassenger(world, best, Passenger.Y),
  };
}

/** Index of the junction nearest a point, by Chebyshev distance in whole units. */
function nearestNode(city: RuntimeCity, x: number, y: number): number {
  const nodes = city.packed.nodes;
  let best = -1;
  let bestDistance = Number.MAX_SAFE_INTEGER;

  for (let node = 0; node * NODE_WORDS < nodes.length; node += 1) {
    const dx = Math.abs(fxFloorToInt(nodes[node * NODE_WORDS] as number) - fxFloorToInt(x));
    const dy = Math.abs(fxFloorToInt(nodes[node * NODE_WORDS + 1] as number) - fxFloorToInt(y));
    const distance = Math.max(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

/**
 * The next junction to head for, on a shortest path to `goalNode`.
 *
 * Breadth-first, over the same one-way-respecting exit lists the traffic uses.
 * Recomputed every tick, which is wasteful and completely irrelevant: the bot
 * runs offline to record a log, and it is the recorded *log* that gets
 * replayed. `M-14` should cache this if it ever matters.
 */
function nextWaypoint(city: RuntimeCity, fromNode: number, goalNode: number): number {
  if (fromNode === goalNode) return goalNode;

  const nodeCount = city.packed.nodes.length / NODE_WORDS;
  const cameFrom = new Int32Array(nodeCount).fill(-1);
  const queue = [fromNode];
  cameFrom[fromNode] = fromNode;

  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head] as number;
    if (node === goalNode) break;

    const start = city.nav.nodeExitStart[node] as number;
    const end = city.nav.nodeExitStart[node + 1] as number;
    for (let i = start; i < end; i += 1) {
      const exit = city.nav.nodeExits[i] as number;
      const edge = exit >> 1;
      const reverse = (exit & 1) === 1;
      const next = city.packed.edges[edge * 4 + (reverse ? 0 : 1)] as number;
      if ((cameFrom[next] as number) >= 0) continue;
      cameFrom[next] = node;
      queue.push(next);
    }
  }

  if ((cameFrom[goalNode] as number) < 0) return goalNode;

  // Walk back to the step that leaves `fromNode`.
  let node = goalNode;
  while ((cameFrom[node] as number) !== fromNode) {
    node = cameFrom[node] as number;
    if (node === fromNode) break;
  }
  return node;
}

/** One tick of input, from the world alone, so a replay reproduces it exactly. */
export function botInput(world: World, city: RuntimeCity): number {
  const destination = target(world, city);
  if (destination === null) return Input.Throttle;

  const carX = getCar(world, 0, Car.X);
  const carY = getCar(world, 0, Car.Y);

  // Aim at the target directly once it is close, otherwise at the next junction
  // on the way. This is what keeps the cab on roads rather than through walls.
  let goal = destination;
  const straightLine = Math.max(
    Math.abs(fxFloorToInt(destination.x) - fxFloorToInt(carX)),
    Math.abs(fxFloorToInt(destination.y) - fxFloorToInt(carY)),
  );

  if (straightLine > WAYPOINT_UNITS && city.packed.nodes.length > 0) {
    const from = nearestNode(city, carX, carY);
    const to = nearestNode(city, destination.x, destination.y);
    const waypoint = nextWaypoint(city, from, to);
    const base = waypoint * NODE_WORDS;
    const wx = city.packed.nodes[base] as number;
    const wy = city.packed.nodes[base + 1] as number;
    const atWaypoint =
      Math.max(
        Math.abs(fxFloorToInt(wx) - fxFloorToInt(carX)),
        Math.abs(fxFloorToInt(wy) - fxFloorToInt(carY)),
      ) <= 2;
    if (!atWaypoint) goal = { x: wx, y: wy };
  }

  const wanted = fxAtan2(goal.y - carY, goal.x - carX);
  const heading = getCar(world, 0, Car.Heading) & 0xffff;
  // Signed shortest turn, in turn units.
  const error = (((wanted - heading + TURN / 2) & 0xffff) - TURN / 2) | 0;

  // Braking is judged against the real target, not the waypoint — the cab
  // should barrel through junctions and slow for the kerb.
  const distance = straightLine;

  let input = 0;
  if (error > TURN / 512) input |= Input.Right;
  else if (error < -TURN / 512) input |= Input.Left;

  const speed = carSpeed(world, 0);

  // Stuck recovery. A cab pinned against a building has zero speed and is
  // nowhere near its target, and steering harder into the wall does not help;
  // braking from rest reverses (car.ts), and steering the other way while
  // backing out points it somewhere new. Without this the first golden run
  // wedged itself on a corner at tick 900 and idled for the remaining 2,100.
  if (speed < FX_ONE / 64 && distance > 3) {
    return (input & Input.Right ? Input.Left : Input.Right) | Input.Brake;
  }

  if (distance <= 2) {
    // Close enough that stopping is the job. Brake until stopped, then coast so
    // the pickup radius check can fire.
    if (speed > FX_ONE / 16) input |= Input.Brake;
  } else if (distance <= APPROACH_UNITS && speed > FX_ONE / 3) {
    input |= Input.Brake;
  } else if (Math.abs(error) < SHARP_TURN || speed < FX_ONE / 4) {
    input |= Input.Throttle;
  }

  return input;
}
