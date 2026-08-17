/**
 * `city.ts` — the city, prepared for the sim.
 *
 * `@deadhead/proto` owns the *format* (`W-01`); this owns what the sim needs
 * done to it once, at load, rather than every tick: building the collision
 * index from the packed building list.
 *
 * A {@link RuntimeCity} is an **input**, not state. It never changes during a
 * run, so it is shared by reference across every `step()` copy and is
 * deliberately not serialised and not hashed — see ADR 0004. Its content hash
 * *is* folded into the run seed (ADR 0005), which is what makes editing the
 * city invalidate old runs rather than silently rescore them.
 */
import { type PackedCity, packCity, emptyCityJson, validateCity } from '@deadhead/proto';

import { buildStaticGeometry, type StaticGeometry } from './collide.js';
import { fxAtan2, fxIntSqrt } from './fx.js';

/**
 * The road network, indexed for traversal.
 *
 * `W-01` stores edges as a flat list; `S-08` needs to ask "which roads leave
 * this junction, and may I use them in that direction". This is that index,
 * built once at load in CSR form — a prefix-summed offset array plus a flat
 * list — because iteration order has to be identical on every machine and a
 * flat array is deterministic by construction.
 */
export interface NavGraph {
  /** Length of each edge, 16.16. */
  readonly edgeLength: Int32Array;
  /** Heading from `a` to `b` for each edge, as a `uint16` turn. */
  readonly edgeHeading: Int32Array;
  /** CSR offsets into {@link nodeExits}, length `nodeCount + 1`. */
  readonly nodeExitStart: Int32Array;
  /**
   * Traversals leaving each node, encoded as `(edgeIndex << 1) | reverse`.
   * A one-way edge appears only in its `a` node's list.
   */
  readonly nodeExits: Int32Array;
}

/** A packed city plus everything derived from it that the sim needs. */
export interface RuntimeCity {
  /** The format-level city, as loaded. */
  readonly packed: PackedCity;
  /** Collision index over {@link PackedCity.buildings}, built once at load. */
  readonly statics: StaticGeometry;
  /** Road network index for NPC traffic (`S-08`). */
  readonly nav: NavGraph;
}

/**
 * Prepare a packed city for play.
 *
 * Validates first: a city that fails structural validation should never reach
 * the sim, and the replay validator loads untrusted cities by id.
 */
export function prepareCity(packed: PackedCity): RuntimeCity {
  validateCity(packed);
  return {
    packed,
    statics: buildStaticGeometry(packed.buildings),
    nav: buildNavGraph(packed),
  };
}

const NODE_WORDS = 3;
const EDGE_WORDS = 4;
/** `EdgeFlags.OneWay`, mirrored so this file does not import a flag to read a bit. */
const ONE_WAY = 1 << 0;

/**
 * Measure and index the road network.
 *
 * Edge lengths are computed in **sixteenths of a unit**, not 16.16. A road can
 * be thousands of units long, and squaring an absolute-scale delta in 16.16
 * overflows (ADR 0003); in sixteenths the squares stay well inside a `Number`'s
 * exact-integer range, and a sixteenth of a unit is far finer than anything the
 * simulation can observe.
 */
function buildNavGraph(packed: PackedCity): NavGraph {
  const nodeCount = packed.nodes.length / NODE_WORDS;
  const edgeCount = packed.edges.length / EDGE_WORDS;

  const edgeLength = new Int32Array(edgeCount);
  const edgeHeading = new Int32Array(edgeCount);
  const nodeExitStart = new Int32Array(nodeCount + 1);

  for (let edge = 0; edge < edgeCount; edge += 1) {
    const base = edge * EDGE_WORDS;
    const a = (packed.edges[base] as number) * NODE_WORDS;
    const b = (packed.edges[base + 1] as number) * NODE_WORDS;

    const dx = (packed.nodes[b] as number) - (packed.nodes[a] as number);
    const dy = (packed.nodes[b + 1] as number) - (packed.nodes[a + 1] as number);

    const dxSixteenths = dx >> 12;
    const dySixteenths = dy >> 12;
    edgeLength[edge] = fxIntSqrt(dxSixteenths * dxSixteenths + dySixteenths * dySixteenths) << 12;
    edgeHeading[edge] = fxAtan2(dy, dx);

    nodeExitStart[(packed.edges[base] as number) + 1] += 1;
    if (((packed.edges[base + 3] as number) & ONE_WAY) === 0) {
      nodeExitStart[(packed.edges[base + 1] as number) + 1] += 1;
    }
  }

  for (let node = 0; node < nodeCount; node += 1) nodeExitStart[node + 1] += nodeExitStart[node];

  const nodeExits = new Int32Array(nodeExitStart[nodeCount] as number);
  const cursor = Int32Array.from(nodeExitStart.subarray(0, nodeCount));
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const base = edge * EDGE_WORDS;
    const a = packed.edges[base] as number;
    const b = packed.edges[base + 1] as number;

    nodeExits[cursor[a] as number] = edge << 1;
    cursor[a] = (cursor[a] as number) + 1;

    if (((packed.edges[base + 3] as number) & ONE_WAY) === 0) {
      nodeExits[cursor[b] as number] = (edge << 1) | 1;
      cursor[b] = (cursor[b] as number) + 1;
    }
  }

  return { edgeLength, edgeHeading, nodeExitStart, nodeExits };
}

/** A valid city with nothing in it. Useful for tests and for a run with no city loaded. */
export function emptyCity(): RuntimeCity {
  return prepareCity(packCity(emptyCityJson('empty')));
}
