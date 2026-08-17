/**
 * `city.ts` — the city format.
 *
 * Two representations of the same thing:
 *
 * - **{@link CityJson}** is what `W-02`'s editor writes and a human can read and
 *   diff. Coordinates are whole units.
 * - **{@link PackedCity}** is what ships and what runs. One flat little-endian
 *   byte buffer, coordinates in 16.16, sections laid out back to back.
 *
 * {@link packCity} converts one to the other and {@link unpackCity} reverses it.
 *
 * ## The content hash is load-bearing
 *
 * Every packed city carries an FNV-1a hash of its own bytes, and that hash is
 * **folded into the run seed** ({@link foldCityHashIntoSeed}). So editing the
 * city changes every seed derived from it, which means old leaderboard entries
 * stop matching rather than silently replaying against different geometry and
 * producing a different score. Invalidating a board is a visible failure;
 * quietly scoring runs against a city that no longer exists is not.
 *
 * See ADR 0005.
 *
 * ## What is deliberately not here
 *
 * `W-01` is the *format*. The semantic checks — unreachable spawns, dead-end
 * nav nodes, destinations inside buildings, spawn points with no road access —
 * belong to `W-02`'s editor, which is where a human can be shown the problem on
 * a map. {@link validateCity} does the structural half: indices in range,
 * coordinates inside the envelope, counts within caps, hash intact.
 *
 * Fields that `W-03`/`W-04` will discover they want differently than anyone
 * would guess now — lane counts, per-edge speed limits, sidewalk geometry — are
 * **reserved rather than invented**, exactly as the passenger and traffic
 * regions were in `S-05`.
 */
import { FX_ONE, WORLD_MAX, WORLD_MIN } from './space.js';
import { CITY_FORMAT_VERSION } from './format.js';

/** `"DHC1"` little-endian. A wrong magic is a wrong file, not a wrong version. */
const CITY_MAGIC = 0x31434844;

/** Header size in bytes. 16 `u32` slots, four of them reserved. */
const HEADER_BYTES = 64;

/** Nothing in a city may exceed these. They bound both memory and validation cost. */
export const CityCaps = {
  nodes: 4_096,
  edges: 8_192,
  buildings: 4_096,
  spawns: 512,
  destinations: 512,
  demandAnchors: 64,
  landmarks: 256,
  names: 512,
  /** Hard ceiling on a packed city, so a hostile file is rejected before it is parsed. */
  bytes: 1 << 20,
} as const;

/**
 * A point or node with no name.
 *
 * **`-1`, not `0xffffffff`.** The name sections are read back as an
 * `Int32Array`, so an unsigned sentinel written through `setInt32` returns as
 * `-1` and never compares equal to the constant it was written from. Caught by
 * the four-block city failing validation on its own unnamed spawns.
 */
export const NO_NAME = -1;

/** Per-edge bit flags. */
export const EdgeFlags = {
  /** Traversable only from `a` to `b`. `W-03` wants one-way streets for route knowledge. */
  OneWay: 1 << 0,
} as const;

// ---------------------------------------------------------------------------
// Authoring format
// ---------------------------------------------------------------------------

/** A junction. Coordinates are whole units. */
export interface CityNode {
  readonly x: number;
  readonly y: number;
  /** Index into {@link CityJson.names}, for street signage (`W-06`). */
  readonly name?: number;
}

/** A directed link between two junctions. Both the road and the NPC nav graph use these. */
export interface CityEdge {
  /** Index into {@link CityJson.nodes}. */
  readonly a: number;
  readonly b: number;
  /** Carriageway width in whole units. */
  readonly width: number;
  /** See {@link EdgeFlags}. */
  readonly flags?: number;
}

/** An axis-aligned box in whole units. Buildings and props both use this. */
export interface CityBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** A point with optional name and flags. Spawns, destinations and landmarks all use this. */
export interface CityPoint {
  readonly x: number;
  readonly y: number;
  readonly name?: number;
  readonly flags?: number;
}

/** An anchor of the migrating demand field (`DESIGN.md` §2.2). */
export interface CityDemandAnchor {
  readonly x: number;
  readonly y: number;
  /** Influence radius in whole units. */
  readonly radius: number;
  /**
   * Where in the run this anchor peaks, as a fraction of the run in 1/256ths.
   * `S-09` owns the migration curve; this is only when the anchor is hottest.
   */
  readonly phase?: number;
}

/** The authoring format. */
export interface CityJson {
  readonly version: number;
  readonly name: string;
  readonly nodes: readonly CityNode[];
  readonly edges: readonly CityEdge[];
  /** Collidable geometry — buildings and props are the same thing to `S-07`. */
  readonly buildings: readonly CityBox[];
  /** Where passengers appear. On a pavement, beside a road (`S-09`). */
  readonly spawns: readonly CityPoint[];
  /** Where they want to go (`S-09`). */
  readonly destinations: readonly CityPoint[];
  readonly demandAnchors: readonly CityDemandAnchor[];
  /** Named silhouettes a player navigates by, instead of an arrow (`DESIGN.md` §2.4, `W-06`). */
  readonly landmarks: readonly CityPoint[];
  /** Street and landmark names, referenced by index. */
  readonly names: readonly string[];
}

/** An empty but valid city. The base for tests and for the editor's "new city". */
export function emptyCityJson(name = 'untitled'): CityJson {
  return {
    version: CITY_FORMAT_VERSION,
    name,
    nodes: [],
    edges: [],
    buildings: [],
    spawns: [],
    destinations: [],
    demandAnchors: [],
    landmarks: [],
    names: [],
  };
}

// ---------------------------------------------------------------------------
// Packed format
// ---------------------------------------------------------------------------

/** Header slot indices, in `u32` units. Reordering one is a format version bump. */
const Slot = {
  Magic: 0,
  Version: 1,
  /** FNV-1a over every byte after this slot. See {@link cityContentHash}. */
  ContentHash: 2,
  NodeCount: 3,
  EdgeCount: 4,
  BuildingCount: 5,
  SpawnCount: 6,
  DestinationCount: 7,
  DemandCount: 8,
  LandmarkCount: 9,
  NameCount: 10,
  NameBytes: 11,
  // Slots 12–15 reserved.
} as const;

const NODE_WORDS = 3; // x, y, name
const EDGE_WORDS = 4; // a, b, width, flags
const BOX_WORDS = 4; // minX, minY, maxX, maxY
const POINT_WORDS = 4; // x, y, name, flags
const DEMAND_WORDS = 4; // x, y, radius, phase

/**
 * A packed city: the bytes, plus decoded views onto them.
 *
 * The views are `subarray`s of one buffer, so nothing is copied. `S-07`'s
 * spatial hash is built from {@link buildings} directly.
 */
export interface PackedCity {
  readonly bytes: Uint8Array;
  readonly contentHash: number;
  readonly nodes: Int32Array;
  readonly edges: Int32Array;
  readonly buildings: Int32Array;
  readonly spawns: Int32Array;
  readonly destinations: Int32Array;
  readonly demandAnchors: Int32Array;
  readonly landmarks: Int32Array;
  /**
   * Name strings as raw UTF-8, **not decoded**.
   *
   * Decoding is deferred to {@link cityName} because the only consumer is
   * signage in the browser (`W-06`). The replay validator loads the same city
   * on every submission and has no use for street names; making it decode a few
   * hundred strings each time would be pure waste.
   */
  readonly nameBytes: readonly Uint8Array[];
}

const unitsToFx = (units: number): number => Math.round(units * FX_ONE) | 0;

/**
 * Fold a city's content hash into a run seed.
 *
 * This is what makes a city edit invalidate old runs rather than silently
 * rescore them. It is deliberately **not** identity when the hash is zero: the
 * run seed is always a function of both inputs, so there is one rule rather
 * than a rule and an exception.
 *
 * Note what it does and does not guarantee: a deserialised world carries both
 * the seed and the city hash, but nothing can verify its PRNG lanes were
 * actually derived from that pair. This makes stale replays *fail loudly*; it
 * is not an authentication mechanism. `B-06`'s server-minted run token is.
 */
export function foldCityHashIntoSeed(seed: number, cityHash: number): number {
  let z = (seed ^ Math.imul(cityHash | 0, 0x9e3779b9)) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) | 0;
}

/** FNV-1a over every byte after the hash slot. */
export function cityContentHash(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = (Slot.ContentHash + 1) * 4; i < bytes.length; i += 1) {
    hash ^= bytes[i] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Convert the authoring format to the runtime format. */
export function packCity(city: CityJson): PackedCity {
  requireCap(city.nodes.length, CityCaps.nodes, 'nodes');
  requireCap(city.edges.length, CityCaps.edges, 'edges');
  requireCap(city.buildings.length, CityCaps.buildings, 'buildings');
  requireCap(city.spawns.length, CityCaps.spawns, 'spawns');
  requireCap(city.destinations.length, CityCaps.destinations, 'destinations');
  requireCap(city.demandAnchors.length, CityCaps.demandAnchors, 'demandAnchors');
  requireCap(city.landmarks.length, CityCaps.landmarks, 'landmarks');
  requireCap(city.names.length, CityCaps.names, 'names');

  const encoder = new TextEncoder();
  const encodedNames = city.names.map((name) => encoder.encode(name));
  const nameBytes = encodedNames.reduce((total, name) => total + 4 + name.length, 0);
  const nameSection = align4(nameBytes);

  const bodyWords =
    city.nodes.length * NODE_WORDS +
    city.edges.length * EDGE_WORDS +
    city.buildings.length * BOX_WORDS +
    city.spawns.length * POINT_WORDS +
    city.destinations.length * POINT_WORDS +
    city.demandAnchors.length * DEMAND_WORDS +
    city.landmarks.length * POINT_WORDS;

  const total = HEADER_BYTES + bodyWords * 4 + nameSection;
  if (total > CityCaps.bytes) {
    throw new RangeError(`packed city is ${total} bytes, max ${CityCaps.bytes}`);
  }

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  view.setUint32(Slot.Magic * 4, CITY_MAGIC, true);
  view.setUint32(Slot.Version * 4, CITY_FORMAT_VERSION, true);
  view.setUint32(Slot.NodeCount * 4, city.nodes.length, true);
  view.setUint32(Slot.EdgeCount * 4, city.edges.length, true);
  view.setUint32(Slot.BuildingCount * 4, city.buildings.length, true);
  view.setUint32(Slot.SpawnCount * 4, city.spawns.length, true);
  view.setUint32(Slot.DestinationCount * 4, city.destinations.length, true);
  view.setUint32(Slot.DemandCount * 4, city.demandAnchors.length, true);
  view.setUint32(Slot.LandmarkCount * 4, city.landmarks.length, true);
  view.setUint32(Slot.NameCount * 4, city.names.length, true);
  view.setUint32(Slot.NameBytes * 4, nameSection, true);

  let at = HEADER_BYTES;
  const put = (value: number): void => {
    view.setInt32(at, value | 0, true);
    at += 4;
  };

  for (const node of city.nodes) {
    put(unitsToFx(node.x));
    put(unitsToFx(node.y));
    put(node.name ?? NO_NAME);
  }
  for (const edge of city.edges) {
    put(edge.a);
    put(edge.b);
    put(unitsToFx(edge.width));
    put(edge.flags ?? 0);
  }
  for (const box of city.buildings) {
    put(unitsToFx(box.minX));
    put(unitsToFx(box.minY));
    put(unitsToFx(box.maxX));
    put(unitsToFx(box.maxY));
  }
  for (const list of [city.spawns, city.destinations]) {
    for (const point of list) {
      put(unitsToFx(point.x));
      put(unitsToFx(point.y));
      put(point.name ?? NO_NAME);
      put(point.flags ?? 0);
    }
  }
  for (const anchor of city.demandAnchors) {
    put(unitsToFx(anchor.x));
    put(unitsToFx(anchor.y));
    put(unitsToFx(anchor.radius));
    put(anchor.phase ?? 0);
  }
  for (const landmark of city.landmarks) {
    put(unitsToFx(landmark.x));
    put(unitsToFx(landmark.y));
    put(landmark.name ?? NO_NAME);
    put(landmark.flags ?? 0);
  }

  for (const name of encodedNames) {
    view.setUint32(at, name.length, true);
    at += 4;
    bytes.set(name, at);
    at += name.length;
  }

  view.setUint32(Slot.ContentHash * 4, cityContentHash(bytes), true);

  return unpackCity(bytes);
}

/**
 * Read a packed city, rejecting anything that is not one.
 *
 * Every check guards something a hostile or stale file could otherwise do:
 * a wrong magic is a wrong file; a wrong version is a stale one; a bad count
 * makes a section overrun; an out-of-range node index makes an edge point at
 * memory that is not a node.
 */
export function unpackCity(bytes: Uint8Array): PackedCity {
  if (bytes.length > CityCaps.bytes) {
    throw new RangeError(`packed city is ${bytes.length} bytes, max ${CityCaps.bytes}`);
  }
  if (bytes.length < HEADER_BYTES) {
    throw new RangeError(`packed city is ${bytes.length} bytes, shorter than its header`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(Slot.Magic * 4, true) !== CITY_MAGIC) {
    throw new RangeError('not a packed city (bad magic)');
  }

  const version = view.getUint32(Slot.Version * 4, true);
  if (version !== CITY_FORMAT_VERSION) {
    throw new RangeError(`city format version ${version}, expected ${CITY_FORMAT_VERSION}`);
  }

  const counts = {
    nodes: readCount(view, Slot.NodeCount, CityCaps.nodes, 'nodes'),
    edges: readCount(view, Slot.EdgeCount, CityCaps.edges, 'edges'),
    buildings: readCount(view, Slot.BuildingCount, CityCaps.buildings, 'buildings'),
    spawns: readCount(view, Slot.SpawnCount, CityCaps.spawns, 'spawns'),
    destinations: readCount(view, Slot.DestinationCount, CityCaps.destinations, 'destinations'),
    demand: readCount(view, Slot.DemandCount, CityCaps.demandAnchors, 'demandAnchors'),
    landmarks: readCount(view, Slot.LandmarkCount, CityCaps.landmarks, 'landmarks'),
    names: readCount(view, Slot.NameCount, CityCaps.names, 'names'),
  };
  const nameSection = view.getUint32(Slot.NameBytes * 4, true);

  const bodyWords =
    counts.nodes * NODE_WORDS +
    counts.edges * EDGE_WORDS +
    counts.buildings * BOX_WORDS +
    counts.spawns * POINT_WORDS +
    counts.destinations * POINT_WORDS +
    counts.demand * DEMAND_WORDS +
    counts.landmarks * POINT_WORDS;

  const expected = HEADER_BYTES + bodyWords * 4 + nameSection;
  if (bytes.length !== expected) {
    throw new RangeError(`packed city is ${bytes.length} bytes, its header describes ${expected}`);
  }

  const words = new Int32Array(bodyWords);
  for (let i = 0; i < bodyWords; i += 1) {
    words[i] = view.getInt32(HEADER_BYTES + i * 4, true);
  }

  let at = 0;
  const take = (count: number, stride: number): Int32Array => {
    const section = words.subarray(at, at + count * stride);
    at += count * stride;
    return section;
  };

  const nodes = take(counts.nodes, NODE_WORDS);
  const edges = take(counts.edges, EDGE_WORDS);
  const buildings = take(counts.buildings, BOX_WORDS);
  const spawns = take(counts.spawns, POINT_WORDS);
  const destinations = take(counts.destinations, POINT_WORDS);
  const demandAnchors = take(counts.demand, DEMAND_WORDS);
  const landmarks = take(counts.landmarks, POINT_WORDS);

  const nameBytes: Uint8Array[] = [];
  let nameAt = HEADER_BYTES + bodyWords * 4;
  const nameEnd = nameAt + nameSection;
  for (let i = 0; i < counts.names; i += 1) {
    if (nameAt + 4 > nameEnd) throw new RangeError('city name table is truncated');
    const length = view.getUint32(nameAt, true);
    nameAt += 4;
    if (nameAt + length > nameEnd) throw new RangeError('city name overruns the name table');
    nameBytes.push(bytes.subarray(nameAt, nameAt + length));
    nameAt += length;
  }

  return {
    bytes,
    contentHash: view.getUint32(Slot.ContentHash * 4, true),
    nodes,
    edges,
    buildings,
    spawns,
    destinations,
    demandAnchors,
    landmarks,
    nameBytes,
  };
}

/** Decode one name. Browser-side only — see {@link PackedCity.nameBytes}. */
export function cityName(city: PackedCity, index: number): string {
  const raw = city.nameBytes[index];
  if (raw === undefined) throw new RangeError(`no name at index ${index}`);
  return new TextDecoder().decode(raw);
}

/**
 * Structural validation. Throws on the first problem, with a message naming it.
 *
 * **Structural only.** Whether a spawn is reachable, whether a nav node is a
 * dead end, whether a destination sits inside a building — those are `W-02`'s,
 * because they want a map and a human. This is what has to hold before any of
 * that is even meaningful.
 */
export function validateCity(city: PackedCity): void {
  if (cityContentHash(city.bytes) !== city.contentHash) {
    throw new RangeError('city content hash does not match its bytes');
  }

  const nodeCount = city.nodes.length / NODE_WORDS;

  for (let i = 0; i < city.nodes.length; i += NODE_WORDS) {
    requireInWorld(city.nodes[i] as number, `node ${i / NODE_WORDS} x`);
    requireInWorld(city.nodes[i + 1] as number, `node ${i / NODE_WORDS} y`);
    requireName(city.nodes[i + 2] as number, city.nameBytes.length, `node ${i / NODE_WORDS}`);
  }

  for (let i = 0; i < city.edges.length; i += EDGE_WORDS) {
    const index = i / EDGE_WORDS;
    for (const end of [0, 1]) {
      const node = city.edges[i + end] as number;
      if (node < 0 || node >= nodeCount) {
        throw new RangeError(`edge ${index} references node ${node}, of ${nodeCount}`);
      }
    }
    if ((city.edges[i] as number) === (city.edges[i + 1] as number)) {
      throw new RangeError(`edge ${index} is a self-loop`);
    }
    if ((city.edges[i + 2] as number) <= 0) {
      throw new RangeError(`edge ${index} has non-positive width`);
    }
  }

  for (let i = 0; i < city.buildings.length; i += BOX_WORDS) {
    const index = i / BOX_WORDS;
    const [minX, minY, maxX, maxY] = [
      city.buildings[i] as number,
      city.buildings[i + 1] as number,
      city.buildings[i + 2] as number,
      city.buildings[i + 3] as number,
    ];
    requireInWorld(minX, `building ${index} minX`);
    requireInWorld(minY, `building ${index} minY`);
    requireInWorld(maxX, `building ${index} maxX`);
    requireInWorld(maxY, `building ${index} maxY`);
    if (maxX <= minX || maxY <= minY) {
      throw new RangeError(`building ${index} is inverted or degenerate`);
    }
  }

  for (const [label, section] of [
    ['spawn', city.spawns],
    ['destination', city.destinations],
    ['landmark', city.landmarks],
  ] as const) {
    for (let i = 0; i < section.length; i += POINT_WORDS) {
      const index = i / POINT_WORDS;
      requireInWorld(section[i] as number, `${label} ${index} x`);
      requireInWorld(section[i + 1] as number, `${label} ${index} y`);
      requireName(section[i + 2] as number, city.nameBytes.length, `${label} ${index}`);
    }
  }

  for (let i = 0; i < city.demandAnchors.length; i += DEMAND_WORDS) {
    const index = i / DEMAND_WORDS;
    requireInWorld(city.demandAnchors[i] as number, `demand anchor ${index} x`);
    requireInWorld(city.demandAnchors[i + 1] as number, `demand anchor ${index} y`);
    if ((city.demandAnchors[i + 2] as number) <= 0) {
      throw new RangeError(`demand anchor ${index} has non-positive radius`);
    }
  }
}

function requireInWorld(fixed: number, what: string): void {
  const units = fixed / FX_ONE;
  if (units < WORLD_MIN || units > WORLD_MAX) {
    throw new RangeError(`${what} is ${units} units, outside ±${WORLD_MAX}`);
  }
}

function requireName(name: number, nameCount: number, what: string): void {
  if (name === NO_NAME) return;
  if (name < 0 || name >= nameCount) {
    throw new RangeError(`${what} references name ${name}, of ${nameCount}`);
  }
}

function requireCap(count: number, cap: number, what: string): void {
  if (count > cap) throw new RangeError(`city has ${count} ${what}, max ${cap}`);
}

function readCount(view: DataView, slot: number, cap: number, what: string): number {
  const count = view.getUint32(slot * 4, true);
  if (count > cap) throw new RangeError(`city declares ${count} ${what}, max ${cap}`);
  return count;
}

const align4 = (n: number): number => (n + 3) & ~3;
