/**
 * `traffic.ts` — NPC vehicles.
 *
 * ## The constraint that pays for itself
 *
 * **Nothing a player does may alter an NPC's trajectory.** A collision affects
 * the *player* only: the cab stops, the bus does not notice. Do not "improve"
 * this into mutual collision, and do not let any code in this file read a cab's
 * position, velocity, or anything else about a player.
 *
 * The reason is bandwidth. Traffic driven purely from the run seed and the tick
 * number is reproduced *identically* by every client and by the server, so it
 * never has to be transmitted at all — a dozen vehicles at 30 Hz that cost
 * nothing. It is the cheapest thing in the whole netcode design, and it is only
 * cheap while this constraint holds. The moment a player can nudge a bus, every
 * client needs to be told where the bus is.
 *
 * Two things enforce it:
 *
 * - This module reads no car state. There is nothing in scope to read.
 * - It draws from a **separate generator** ({@link trafficRngOf}). That is
 *   subtler and matters more: sharing the world's main stream would couple
 *   traffic to player behaviour without anyone writing a line of code to do it.
 *   Picking up a passenger changes the waiting population, which changes
 *   whether a spawn is attempted, which changes how many numbers are drawn —
 *   and every NPC downstream would drift. Two streams, no coupling.
 *
 * ## Why traffic is stored rather than derived
 *
 * `S-08`'s brief says NPCs are "driven purely from the seed and tick number",
 * which reads like they need no state at all. They are deterministic, but they
 * are not *closed-form*: a vehicle following a road network is an incremental
 * integration, so working out where it is at tick T without storing anything
 * would mean replaying from tick 0. Storing it keeps `step()` O(1) per tick.
 * The bandwidth win is unaffected — that comes from never *transmitting*
 * traffic, not from never storing it. See ADR 0004.
 */
import { EdgeFlags } from '@deadhead/proto';

import type { RuntimeCity } from './city.js';
import { fxDiv, fxFromRatio, fxMul } from './fx.js';
import { rngNextBelow, rngNextRange } from './rng.js';
import {
  Header,
  MAX_TRAFFIC,
  Traffic,
  TrafficFlags,
  getTraffic,
  setTraffic,
  trafficRngOf,
  type World,
} from './world.js';

const NODE_WORDS = 3;
const EDGE_WORDS = 4;

export const TrafficTuning = {
  /** How many vehicles to keep on the road. `W-04` tunes this against the real city. */
  count: 24,

  /** Slowest an NPC travels, units per tick. */
  minSpeed: fxFromRatio(9, 30),

  /** Fastest an NPC travels, units per tick. Below a cab's top speed, so a cab can overtake. */
  maxSpeed: fxFromRatio(17, 30),
} as const;

/** Vehicles currently on the road. */
export function trafficCount(world: World): number {
  return world.data[Header.TrafficCount] as number;
}

/** True if this slot holds a live vehicle. */
export function isTrafficActive(world: World, slot: number): boolean {
  return (getTraffic(world, slot, Traffic.Flags) & TrafficFlags.Active) !== 0;
}

/**
 * Fill the roads. Called once, by `createWorld`, after the city is attached.
 *
 * A city with no usable roads simply gets no traffic — an empty city is a valid
 * city, and `W-02` is where an author is told their network is broken.
 */
export function initTraffic(world: World): void {
  const city = world.city;
  if (city === undefined) return;

  const edgeCount = city.packed.edges.length / EDGE_WORDS;
  if (edgeCount === 0) return;

  const rng = trafficRngOf(world);
  const wanted = Math.min(TrafficTuning.count, MAX_TRAFFIC);

  for (let slot = 0; slot < wanted; slot += 1) {
    const edge = rngNextBelow(rng, edgeCount);
    const length = city.nav.edgeLength[edge] as number;
    if (length <= 0) continue;

    // Drawn unconditionally so the number of draws does not depend on the
    // city's shape, then discarded for a one-way street. Placing a vehicle
    // reversed on a one-way is how one ends up driving the wrong way up it from
    // the very first tick — caught by a test, not by inspection.
    const wantsReverse = rngNextBelow(rng, 2) === 1;
    const oneWay = ((city.packed.edges[edge * EDGE_WORDS + 3] as number) & EdgeFlags.OneWay) !== 0;
    const reverse = wantsReverse && !oneWay;
    setTraffic(
      world,
      slot,
      Traffic.Flags,
      TrafficFlags.Active | (reverse ? TrafficFlags.Reverse : 0),
    );
    setTraffic(world, slot, Traffic.Edge, edge);
    setTraffic(world, slot, Traffic.Progress, rngNextBelow(rng, length));
    setTraffic(
      world,
      slot,
      Traffic.Speed,
      rngNextRange(rng, TrafficTuning.minSpeed, TrafficTuning.maxSpeed + 1),
    );
    world.data[Header.TrafficCount] = trafficCount(world) + 1;

    placeOnEdge(world, slot, city);
  }
}

/**
 * Advance every vehicle by one tick.
 *
 * Reads the city, the traffic region and the traffic generator. **Nothing
 * else** — see the note at the top of this file.
 */
export function stepTraffic(world: World): void {
  const city = world.city;
  if (city === undefined) return;

  const rng = trafficRngOf(world);

  for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) {
    if (!isTrafficActive(world, slot)) continue;

    let edge = getTraffic(world, slot, Traffic.Edge);
    let reverse = (getTraffic(world, slot, Traffic.Flags) & TrafficFlags.Reverse) !== 0;
    let progress =
      getTraffic(world, slot, Traffic.Progress) + getTraffic(world, slot, Traffic.Speed);

    // A junction may be crossed more than once in a tick on a very short road,
    // so this is a loop. Bounded, so a degenerate zero-length network cannot
    // hang the sim — a city can be wrong; the tick cannot be infinite.
    for (let hops = 0; hops < 4; hops += 1) {
      const length = city.nav.edgeLength[edge] as number;
      if (length <= 0 || progress < length) break;

      progress -= length;

      const arrivedAt = endNode(city, edge, reverse);
      const exit = chooseExit(city, arrivedAt, edge, rng);
      if (exit < 0) {
        // Nowhere to go — a dead end with no way back. Hold at the junction
        // rather than vanishing; W-02 flags dead-end nav nodes for the author.
        progress = length;
        break;
      }
      edge = exit >> 1;
      reverse = (exit & 1) === 1;
    }

    setTraffic(
      world,
      slot,
      Traffic.Flags,
      TrafficFlags.Active | (reverse ? TrafficFlags.Reverse : 0),
    );
    setTraffic(world, slot, Traffic.Edge, edge);
    setTraffic(world, slot, Traffic.Progress, progress);
    placeOnEdge(world, slot, city);
  }
}

/** The node a vehicle reaches at the far end of its current edge. */
function endNode(city: RuntimeCity, edge: number, reverse: boolean): number {
  const base = edge * EDGE_WORDS;
  return city.packed.edges[base + (reverse ? 0 : 1)] as number;
}

/**
 * Pick a road out of a junction.
 *
 * Doubling back is allowed only when there is no alternative, so traffic flows
 * through the city rather than rattling back and forth along one street. That
 * is a legibility decision as much as a realism one: a player learns the city
 * by watching how it moves.
 */
function chooseExit(city: RuntimeCity, node: number, cameFrom: number, rng: Int32Array): number {
  const start = city.nav.nodeExitStart[node] as number;
  const end = city.nav.nodeExitStart[node + 1] as number;
  const available = end - start;
  if (available <= 0) return -1;

  let onward = 0;
  for (let i = start; i < end; i += 1) {
    if ((city.nav.nodeExits[i] as number) >> 1 !== cameFrom) onward += 1;
  }

  // Draw first, unconditionally, so the number of draws per junction does not
  // depend on the shape of the junction. A variable draw count would still be
  // deterministic, but it makes reasoning about the stream far harder.
  const pick = rngNextBelow(rng, onward > 0 ? onward : available);

  let seen = 0;
  for (let i = start; i < end; i += 1) {
    const exit = city.nav.nodeExits[i] as number;
    if (onward > 0 && exit >> 1 === cameFrom) continue;
    if (seen === pick) return exit;
    seen += 1;
  }
  return city.nav.nodeExits[start] as number;
}

/** Derive world position and heading from the edge and how far along it the vehicle is. */
function placeOnEdge(world: World, slot: number, city: RuntimeCity): void {
  const edge = getTraffic(world, slot, Traffic.Edge);
  const reverse = (getTraffic(world, slot, Traffic.Flags) & TrafficFlags.Reverse) !== 0;
  const base = edge * EDGE_WORDS;

  const from = (city.packed.edges[base + (reverse ? 1 : 0)] as number) * NODE_WORDS;
  const to = (city.packed.edges[base + (reverse ? 0 : 1)] as number) * NODE_WORDS;

  const length = city.nav.edgeLength[edge] as number;
  const progress = getTraffic(world, slot, Traffic.Progress);
  // Fraction along the edge, in 16.16. Both operands are distances along one
  // road, so this stays far inside the arithmetic bound.
  const t = length > 0 ? fxDiv(progress, length) : 0;

  const fromX = city.packed.nodes[from] as number;
  const fromY = city.packed.nodes[from + 1] as number;
  const dx = (city.packed.nodes[to] as number) - fromX;
  const dy = (city.packed.nodes[to + 1] as number) - fromY;

  // fxMul of a large delta by a fraction <= 1.0: the result is bounded by the
  // delta, so it fits even though the delta itself is far past the squarable
  // bound. Nothing here squares a coordinate.
  setTraffic(world, slot, Traffic.X, fromX + fxMul(dx, t));
  setTraffic(world, slot, Traffic.Y, fromY + fxMul(dy, t));

  const heading = city.nav.edgeHeading[edge] as number;
  setTraffic(world, slot, Traffic.Heading, reverse ? (heading + 32_768) & 0xffff : heading);
}
