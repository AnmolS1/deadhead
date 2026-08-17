/**
 * `world.ts` — the state shape, its serialisation, and the determinism oracle.
 *
 * ## One buffer
 *
 * The entire simulation state is a single flat `Int32Array`. Not an object
 * graph, not one typed array per subsystem — one buffer with a documented,
 * versioned layout. Three things fall out of that, and they are the reason for
 * the design rather than happy accidents:
 *
 * - **Copying a world is one allocation and one memcpy.** `step()` is a pure
 *   function that returns a new world, so this happens 30 times a second.
 * - **Serialising is a byte view of that buffer**, written little-endian by
 *   hand (see {@link serialize}).
 * - **Hashing is a walk over contiguous memory**, and — more importantly —
 *   *everything* is hashed by construction. There is no way to add a field to
 *   the world and forget to include it in the hash, which is exactly the bug
 *   that would make the replay validator disagree with the client only
 *   sometimes.
 *
 * ## Immutable, by copy
 *
 * `step(world, inputs)` returns a **new** world; it never mutates its argument.
 * The world is ~5 KB, so copying it costs ~150 KB/s at 30 Hz, which is nothing.
 * What it buys is large:
 *
 * - `M-06` reconciliation replays inputs from a retained past state. With
 *   copy-on-step, "retain a past state" is just holding a reference.
 * - `C-05` renders `lerp(previous, current, alpha)` and needs both.
 * - `G-07`'s ghost runs a second sim in lockstep without any aliasing risk.
 *
 * The one rule this imposes: **subarray views do not survive a copy.** A view
 * such as {@link rngOf} points into a specific buffer, so it must be re-derived
 * against the new world after every step. Carrying one across is an aliasing
 * bug that passes `toEqual` and desyncs.
 *
 * ## What is deliberately not here
 *
 * City data (`W-01`) is an *input* to the sim, not state: it never changes
 * during a run, so copying and hashing it every tick would be waste. Its
 * content hash lives in the header instead, so a world can be checked against
 * the city it was produced with. That is why {@link World} is an object with a
 * `data` field rather than a bare `Int32Array` — the immutable shared
 * references sit alongside the buffer, outside the hash.
 */
import { WORLD_FORMAT_VERSION } from '@deadhead/proto';

import { initClocks } from './clock.js';
import { RNG_LANES, rngIsDegenerate, rngSeed, type RngState } from './rng.js';

// ---------------------------------------------------------------------------
// Capacities
// ---------------------------------------------------------------------------

/** Maximum cabs in a match. `DESIGN.md` §2.3 puts the range at 3–12; single player uses 1. */
export const MAX_PLAYERS = 12;

/** Maximum passengers alive at once. Owned by `S-09`. */
export const MAX_PASSENGERS = 64;

/** Maximum NPC vehicles alive at once. Owned by `S-08`. */
export const MAX_TRAFFIC = 64;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Header slots. Scalars that describe the run as a whole.
 *
 * Slot numbers are part of the serialised format: reordering them is a
 * {@link WORLD_FORMAT_VERSION} bump, not a refactor.
 */
export const Header = {
  /** Written by {@link createWorld}, checked by {@link deserialize}. */
  FormatVersion: 0,
  /** Ticks since the run began. */
  Tick: 1,
  /** The run seed. Minted server-side in `B-06`; the client cannot choose it. */
  Seed: 2,
  /** Content hash of the city this run was produced against (`W-01`). */
  CityHash: 3,
  /** Cabs actually in play, `1..MAX_PLAYERS`. */
  PlayerCount: 4,
  /** Passenger slots currently occupied. Owned by `S-09`. */
  PassengerCount: 5,
  /** NPC slots currently occupied. Owned by `S-08`. */
  TrafficCount: 6,
  /** Run-level flags — see {@link WorldFlags}. */
  Flags: 7,
  /** Generator state, {@link RNG_LANES} lanes. See {@link rngOf}. */
  Rng: 8,
} as const;

/** Run-level bit flags stored in {@link Header.Flags}. */
export const WorldFlags = {
  /** Cleared when the run has ended, by whichever condition (`M-09`, `G-01`). */
  Running: 1 << 0,
} as const;

const HEADER_INT32S = 16;

/**
 * Fields of one cab.
 *
 * Positions and velocities are 16.16 fixed point; `Heading` is a `uint16` turn
 * (see `fx.ts`). Velocities are **per tick**, never per second — the sim has no
 * `dt` to multiply by (`constants.ts`).
 */
export const Car = {
  /** Position, 16.16. */
  X: 0,
  Y: 1,
  /** Facing, `uint16` turn. Distinct from the direction of travel — that is where `S-06`'s drift lives. */
  Heading: 2,
  /** Velocity, 16.16 units per tick. */
  VelocityX: 3,
  VelocityY: 4,
  /** Per-cab bit flags. Owned by `S-06`/`G-01`. */
  Flags: 5,
  /** Index into the passenger region, or {@link NO_PASSENGER}. The whole game turns on this field. */
  CarriedPassenger: 6,
  /** Earnings so far, in minor units. Owned by `S-10`. */
  Cash: 7,
  /** Completed fares. The tiebreak for `G-01`'s score. */
  Deliveries: 8,
  /** Ticks of empty-cab time remaining. Decrements only while not carrying — `S-11`. */
  DeadheadTicks: 9,
  /** Ticks elapsed on the current fare. Runs only while carrying — `S-11`. */
  FareTicks: 10,
  /** Ticks until control returns after a crash. Owned by `G-01`. */
  RespawnTicks: 11,
  /** Last input byte applied, so a dropped packet repeats rather than stalls (`M-03`). */
  LastInput: 12,
} as const;

/** Power of two, so indexing is a shift rather than a multiply. Slots 13–15 are reserved. */
const CAR_STRIDE = 16;

/** {@link Car.CarriedPassenger} when the cab is empty — which is when the clock runs. */
export const NO_PASSENGER = -1;

/**
 * Per-cab bit flags stored in {@link Car.Flags}.
 *
 * Lives here rather than in `car.ts` because it is state layout: `car.ts` sets
 * {@link CarFlags.Drifting} and `clock.ts` sets {@link CarFlags.Eliminated}, and
 * neither owns the field.
 */
export const CarFlags = {
  /** Set while the cab is sliding hard enough to read as a drift. Drives `C-08`'s feedback. */
  Drifting: 1 << 0,
  /**
   * Set when this cab's deadhead clock reached zero. **Final** — `grantDeadhead`
   * refuses to revive an eliminated cab, because `M-09`'s "last one still
   * driving" is only a win condition if nobody can come back.
   */
  Eliminated: 1 << 1,
} as const;

/**
 * Fields of one passenger.
 *
 * **Only the first three slots are defined.** The class (`Meter` | `Rush`),
 * destination and patience budget belong to `S-09`/`S-10`, which depend on
 * `W-01`'s spawn points. Reserving the region and versioning the format is
 * cheap; a layout that looks authoritative before its owning task exists is
 * what later tasks build the wrong thing on top of.
 */
export const Passenger = {
  /** Occupancy and state bits. Owned by `S-09`. Zero means the slot is free. */
  Flags: 0,
  /** Position, 16.16. */
  X: 1,
  Y: 2,
} as const;

/** Slots 3–7 reserved for `S-09`. */
const PASSENGER_STRIDE = 8;

/**
 * Fields of one NPC vehicle.
 *
 * As with passengers, only what is already settled is defined; the navigation
 * graph fields belong to `S-08` and depend on `W-01`.
 *
 * Traffic *is* stored, despite `S-08` describing it as derived from seed and
 * tick. It is deterministic but not closed-form: an NPC following a nav graph
 * is an incremental integration, so recomputing its position at tick T without
 * storing it would mean replaying from tick 0. Storing it keeps `step()` O(1)
 * per tick. The bandwidth win `S-08` is really after is that traffic never
 * needs to be *transmitted*, which still holds.
 */
export const Traffic = {
  /** Occupancy and state bits. Owned by `S-08`. Zero means the slot is free. */
  Flags: 0,
  /** Position, 16.16. */
  X: 1,
  Y: 2,
  /** Facing, `uint16` turn. */
  Heading: 3,
} as const;

/** Slots 4–7 reserved for `S-08`. */
const TRAFFIC_STRIDE = 8;

const CARS_OFFSET = HEADER_INT32S;
const PASSENGERS_OFFSET = CARS_OFFSET + MAX_PLAYERS * CAR_STRIDE;
const TRAFFIC_OFFSET = PASSENGERS_OFFSET + MAX_PASSENGERS * PASSENGER_STRIDE;

/** Total size of the state, in `int32`s. */
export const WORLD_INT32S = TRAFFIC_OFFSET + MAX_TRAFFIC * TRAFFIC_STRIDE;

/** Total size of a serialised world, in bytes. */
export const WORLD_BYTES = WORLD_INT32S * 4;

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

/**
 * The complete simulation state at one instant.
 *
 * Treat it as immutable. `step()` returns a new one; nothing else should write
 * to `data` after the world has been handed out.
 */
export interface World {
  /**
   * Every piece of hashed, serialised, transmitted state, in one buffer.
   * Always a full array, never a subarray — {@link cloneWorld} relies on that.
   */
  readonly data: Int32Array;
}

/** A fresh world at tick 0. */
export function createWorld(seed: number, playerCount = 1, cityHash = 0): World {
  const data = new Int32Array(WORLD_INT32S);

  data[Header.FormatVersion] = WORLD_FORMAT_VERSION;
  data[Header.Tick] = 0;
  data[Header.Seed] = seed | 0;
  data[Header.CityHash] = cityHash | 0;
  data[Header.PlayerCount] = Math.max(1, Math.min(playerCount, MAX_PLAYERS));
  data[Header.Flags] = WorldFlags.Running;

  const world: World = { data };
  rngSeed(rngOf(world), seed);

  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    setCar(world, slot, Car.CarriedPassenger, NO_PASSENGER);
  }
  initClocks(world);

  return world;
}

/**
 * An independent copy. One allocation, one memcpy.
 *
 * Copies the buffer, so any subarray view onto the original — {@link rngOf}
 * above all — still points at the *original* and must be re-derived.
 */
export function cloneWorld(world: World): World {
  return { data: new Int32Array(world.data) };
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getTick(world: World): number {
  return world.data[Header.Tick];
}

export function getSeed(world: World): number {
  return world.data[Header.Seed];
}

export function getCityHash(world: World): number {
  return world.data[Header.CityHash];
}

export function getPlayerCount(world: World): number {
  return world.data[Header.PlayerCount];
}

export function getFormatVersion(world: World): number {
  return world.data[Header.FormatVersion];
}

export function isRunning(world: World): boolean {
  return (world.data[Header.Flags] & WorldFlags.Running) !== 0;
}

/**
 * A live view of the generator lanes.
 *
 * Writes through it land in the world, which is the point — drawing a random
 * number is a state change and must be part of the hash. **Re-derive this after
 * every {@link cloneWorld}**; a view held across a copy writes to the old world.
 */
export function rngOf(world: World): RngState {
  return world.data.subarray(Header.Rng, Header.Rng + RNG_LANES);
}

/** Offset of one cab's record. */
function carBase(slot: number): number {
  return CARS_OFFSET + slot * CAR_STRIDE;
}

export function getCar(world: World, slot: number, field: number): number {
  return world.data[carBase(slot) + field];
}

export function setCar(world: World, slot: number, field: number, value: number): void {
  world.data[carBase(slot) + field] = value | 0;
}

export function getPassenger(world: World, slot: number, field: number): number {
  return world.data[PASSENGERS_OFFSET + slot * PASSENGER_STRIDE + field];
}

export function setPassenger(world: World, slot: number, field: number, value: number): void {
  world.data[PASSENGERS_OFFSET + slot * PASSENGER_STRIDE + field] = value | 0;
}

export function getTraffic(world: World, slot: number, field: number): number {
  return world.data[TRAFFIC_OFFSET + slot * TRAFFIC_STRIDE + field];
}

export function setTraffic(world: World, slot: number, field: number, value: number): void {
  world.data[TRAFFIC_OFFSET + slot * TRAFFIC_STRIDE + field] = value | 0;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * The world as bytes, **explicitly little-endian**.
 *
 * `new Uint8Array(data.buffer)` would be one line and would be a latent
 * determinism bug: a typed array's byte order follows the host, so the same
 * world would serialise differently — and therefore hash differently — on a
 * big-endian machine. That is precisely the class of bug that works on every
 * machine you own and fails once, in production, unreproducibly. `DataView`
 * with an explicit `littleEndian` argument costs a few nanoseconds a tick and
 * removes the question.
 */
export function serialize(world: World): Uint8Array {
  const bytes = new Uint8Array(WORLD_BYTES);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < WORLD_INT32S; i += 1) {
    view.setInt32(i * 4, world.data[i], true);
  }

  return bytes;
}

/**
 * Rebuild a world from bytes, rejecting anything that is not one.
 *
 * Everything here is reachable from a hostile or merely stale replay
 * submission, so each check exists because the alternative is a sim that runs
 * happily on nonsense:
 *
 * - **Wrong length** — a truncated buffer would leave the tail zeroed and
 *   validate as a legitimate world.
 * - **Wrong version** — the whole reason `WORLD_FORMAT_VERSION` exists.
 * - **Degenerate generator** — the all-zero xorshift state emits zero forever,
 *   perfectly deterministically. A replay carrying it would *validate cleanly*
 *   while producing a constant world. See `rng.ts`.
 * - **Counts outside their capacity** — every loop in the sim is bounded by one
 *   of these. An out-of-range count does not throw, because a typed-array write
 *   past the end is *silently dropped*: `step()` would simply spin for a few
 *   thousand iterations writing nowhere. Harmless while `step()` only records
 *   an input byte; not harmless once `S-06` reads those slots back, and this
 *   arrives from a public submission endpoint in `B-07`.
 */
export function deserialize(bytes: Uint8Array): World {
  if (bytes.byteLength !== WORLD_BYTES) {
    throw new RangeError(`world must be ${WORLD_BYTES} bytes, got ${bytes.byteLength}`);
  }

  const data = new Int32Array(WORLD_INT32S);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < WORLD_INT32S; i += 1) {
    data[i] = view.getInt32(i * 4, true);
  }

  const version = data[Header.FormatVersion];
  if (version !== WORLD_FORMAT_VERSION) {
    throw new RangeError(`world format version ${version}, expected ${WORLD_FORMAT_VERSION}`);
  }

  const world: World = { data };
  if (rngIsDegenerate(rngOf(world))) {
    throw new RangeError('world carries the all-zero PRNG state, which emits zero forever');
  }

  requireCount(data[Header.PlayerCount], 1, MAX_PLAYERS, 'playerCount');
  requireCount(data[Header.PassengerCount], 0, MAX_PASSENGERS, 'passengerCount');
  requireCount(data[Header.TrafficCount], 0, MAX_TRAFFIC, 'trafficCount');

  return world;
}

/** Reject a header count that would let a loop in the sim run off the end of a region. */
function requireCount(value: number, lo: number, hi: number, name: string): void {
  if (value < lo || value > hi) {
    throw new RangeError(`world ${name} is ${value}, expected ${lo}..${hi}`);
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * FNV-1a over the world's little-endian bytes — the determinism oracle every
 * later test leans on.
 *
 * Computed straight from the `int32`s rather than from {@link serialize}'s
 * output, so hashing a world allocates nothing; the byte order is spelled out
 * to match `serialize` exactly, and a test pins the two together.
 *
 * FNV-1a is not a cryptographic hash and does not need to be. It is a
 * *divergence detector*: two sims that disagree by one unit in one field
 * produce different hashes, which is the entire requirement. Nothing security-
 * relevant depends on it — `B-08` re-runs the replay and compares the score.
 */
export function hashWorld(world: World): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < WORLD_INT32S; i += 1) {
    const value = world.data[i];
    for (let byte = 0; byte < 4; byte += 1) {
      hash ^= (value >>> (byte * 8)) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  }

  return hash >>> 0;
}
