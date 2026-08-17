import { describe, expect, it } from 'vitest';

import { WORLD_FORMAT_VERSION } from '@deadhead/proto';

import {
  Car,
  Header,
  MAX_PASSENGERS,
  MAX_PLAYERS,
  MAX_TRAFFIC,
  NO_PASSENGER,
  Passenger,
  Traffic,
  WORLD_BYTES,
  WORLD_INT32S,
  WorldFlags,
  cloneWorld,
  createWorld,
  deserialize,
  getCar,
  getPlayerCount,
  getSeed,
  getTick,
  hashWorld,
  isRunning,
  rngOf,
  serialize,
  setCar,
  setPassenger,
  setTraffic,
  type World,
} from '../src/world.js';
import { rngNextU32 } from '../src/rng.js';
import { step } from '../src/step.js';

/** Deterministic filler, so a fuzz failure reproduces exactly. */
function* prng(seed: number): Generator<number> {
  let x = seed | 0;
  for (;;) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    yield x | 0;
  }
}

/** Fill every slot of a world with arbitrary values, keeping it structurally valid. */
function randomise(world: World, seed: number): World {
  const rng = prng(seed);
  for (let i = 0; i < WORLD_INT32S; i += 1) {
    world.data[i] = rng.next().value;
  }
  world.data[Header.FormatVersion] = WORLD_FORMAT_VERSION;
  // Keep the generator out of its absorbing fixed point.
  world.data[Header.Rng] = rng.next().value || 1;
  return world;
}

// ---------------------------------------------------------------------------

describe('createWorld', () => {
  it('starts a run at tick 0, running, with the recorded seed', () => {
    const world = createWorld(1234, 4, 0xabcd);
    expect(getTick(world)).toBe(0);
    expect(getSeed(world)).toBe(1234);
    expect(getPlayerCount(world)).toBe(4);
    expect(isRunning(world)).toBe(true);
    expect(world.data[Header.Flags] & WorldFlags.Running).toBeTruthy();
  });

  it('stamps the format version from @deadhead/proto', () => {
    expect(createWorld(1).data[Header.FormatVersion]).toBe(WORLD_FORMAT_VERSION);
  });

  it('clamps the player count into range', () => {
    expect(getPlayerCount(createWorld(1, 0))).toBe(1);
    expect(getPlayerCount(createWorld(1, 999))).toBe(MAX_PLAYERS);
    expect(getPlayerCount(createWorld(1, MAX_PLAYERS))).toBe(MAX_PLAYERS);
  });

  it('starts every cab empty, which is what makes the clock run', () => {
    const world = createWorld(1, MAX_PLAYERS);
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
      expect(getCar(world, slot, Car.CarriedPassenger)).toBe(NO_PASSENGER);
    }
  });

  it('seeds the generator inside the world', () => {
    // Not beside it: the generator state has to be hashed and serialised with
    // everything else, or a resumed sim draws a different stream.
    const world = createWorld(99);
    expect(rngOf(world).some((lane) => lane !== 0)).toBe(true);

    const before = hashWorld(world);
    rngNextU32(rngOf(world));
    expect(hashWorld(world)).not.toBe(before);
  });

  it('is fully determined by its arguments', () => {
    expect(Array.from(createWorld(7, 3, 11).data)).toEqual(Array.from(createWorld(7, 3, 11).data));
    expect(hashWorld(createWorld(7))).not.toBe(hashWorld(createWorld(8)));
  });
});

describe('layout', () => {
  it('has room for every entity the design calls for', () => {
    expect(MAX_PLAYERS).toBe(12);
    expect(WORLD_INT32S).toBeGreaterThan(MAX_PLAYERS + MAX_PASSENGERS + MAX_TRAFFIC);
    expect(WORLD_BYTES).toBe(WORLD_INT32S * 4);
  });

  it('keeps every region disjoint', () => {
    // A stride or offset arithmetic error would silently alias two entities
    // onto the same memory, which reads as a physics bug three tasks later.
    const world = createWorld(1, MAX_PLAYERS);
    world.data.fill(0);

    let marker = 1;
    for (let slot = 0; slot < MAX_PLAYERS; slot += 1) setCar(world, slot, Car.X, marker++);
    for (let slot = 0; slot < MAX_PASSENGERS; slot += 1) {
      setPassenger(world, slot, Passenger.X, marker++);
    }
    for (let slot = 0; slot < MAX_TRAFFIC; slot += 1) setTraffic(world, slot, Traffic.X, marker++);

    const written = world.data.filter((v) => v !== 0);
    expect(written).toHaveLength(marker - 1);
    expect(new Set(written).size).toBe(marker - 1);
  });

  it('does not let the last entity of a region overrun the buffer', () => {
    const world = createWorld(1);
    setTraffic(world, MAX_TRAFFIC - 1, Traffic.Heading, 12345);
    expect(world.data[WORLD_INT32S - 1]).toBeDefined();
    expect(() => setTraffic(world, MAX_TRAFFIC - 1, Traffic.Heading, 1)).not.toThrow();
  });
});

describe('cloneWorld', () => {
  it('is independent of the original', () => {
    const original = createWorld(5);
    const copy = cloneWorld(original);

    setCar(copy, 0, Car.X, 999);
    expect(getCar(original, 0, Car.X)).toBe(0);
    expect(hashWorld(original)).not.toBe(hashWorld(copy));
  });

  it('copies every slot', () => {
    const original = randomise(createWorld(1), 0xc0ffee);
    expect(Array.from(cloneWorld(original).data)).toEqual(Array.from(original.data));
    expect(hashWorld(cloneWorld(original))).toBe(hashWorld(original));
  });

  it('leaves views pointing at the ORIGINAL, which is why they must be re-derived', () => {
    // The aliasing trap called out in world.ts. A view carried across a copy
    // writes to the world you just stopped using — it passes toEqual and
    // desyncs. Pinned here so the hazard is visible rather than folkloric.
    const original = createWorld(5);
    const staleView = rngOf(original);
    const copy = cloneWorld(original);

    rngNextU32(staleView);

    expect(Array.from(rngOf(copy))).not.toEqual(Array.from(staleView));
    expect(Array.from(rngOf(original))).toEqual(Array.from(staleView));
  });
});

describe('serialize / deserialize', () => {
  it('round-trips byte-identically and hash-identically over 1000 fuzzed worlds', () => {
    // S-05's done-when. If this ever fails, every replay and every leaderboard
    // entry is suspect.
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      const world = randomise(createWorld(iteration), 0x1234 + iteration);

      const bytes = serialize(world);
      const restored = deserialize(bytes);

      expect(Array.from(restored.data)).toEqual(Array.from(world.data));
      expect(hashWorld(restored)).toBe(hashWorld(world));
      expect(Array.from(serialize(restored))).toEqual(Array.from(bytes));
    }
  });

  it('produces exactly WORLD_BYTES', () => {
    expect(serialize(createWorld(1)).byteLength).toBe(WORLD_BYTES);
  });

  it('writes little-endian regardless of host byte order', () => {
    // Explicitly, not via `new Uint8Array(data.buffer)`. A typed array's byte
    // order follows the host, so the shortcut would hash differently on a
    // big-endian machine — a bug that works everywhere you can test it.
    const world = createWorld(1);
    world.data.fill(0);
    world.data[Header.FormatVersion] = WORLD_FORMAT_VERSION;
    world.data[Header.Rng] = 1;
    world.data[Header.Tick] = 0x04030201;

    const bytes = serialize(world);
    const base = Header.Tick * 4;
    expect([bytes[base], bytes[base + 1], bytes[base + 2], bytes[base + 3]]).toEqual([
      0x01, 0x02, 0x03, 0x04,
    ]);
  });

  it('round-trips negative values, which is where a sign bug would hide', () => {
    const world = createWorld(1);
    setCar(world, 0, Car.X, -1);
    setCar(world, 0, Car.VelocityY, -0x80000000);
    setCar(world, 1, Car.Cash, -12345);

    const restored = deserialize(serialize(world));
    expect(getCar(restored, 0, Car.X)).toBe(-1);
    expect(getCar(restored, 0, Car.VelocityY)).toBe(-0x80000000);
    expect(getCar(restored, 1, Car.Cash)).toBe(-12345);
  });

  it('rejects a truncated buffer', () => {
    // Silently accepting one would zero-fill the tail and validate as a
    // legitimate world.
    const bytes = serialize(createWorld(1));
    expect(() => deserialize(bytes.subarray(0, WORLD_BYTES - 4))).toThrow(/bytes/);
    expect(() => deserialize(new Uint8Array(0))).toThrow(/bytes/);
  });

  it('rejects a foreign format version', () => {
    const world = createWorld(1);
    world.data[Header.FormatVersion] = WORLD_FORMAT_VERSION + 1;
    expect(() => deserialize(serialize(world))).toThrow(/format version/);
  });

  it('rejects the all-zero PRNG state', () => {
    // It emits zero forever, perfectly deterministically, so a replay carrying
    // it would validate cleanly while producing a constant world.
    const world = createWorld(1);
    rngOf(world).fill(0);
    expect(() => deserialize(serialize(world))).toThrow(/zero/);
  });

  it('deserialises from a buffer with a non-zero byteOffset', () => {
    // Worth pinning: DataView over a subarray must respect byteOffset, and
    // network reads routinely hand you a slice of a larger buffer.
    const world = createWorld(42);
    const bytes = serialize(world);
    const padded = new Uint8Array(WORLD_BYTES + 8);
    padded.set(bytes, 8);

    const restored = deserialize(padded.subarray(8));
    expect(hashWorld(restored)).toBe(hashWorld(world));
  });
});

describe('hashWorld', () => {
  it('agrees with a hash computed over serialize() output', () => {
    // hashWorld reads the int32s directly so it allocates nothing. That is only
    // safe if its byte order matches serialize exactly — pinned here.
    const fnv = (bytes: Uint8Array): number => {
      let hash = 0x811c9dc5;
      for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193);
      }
      return hash >>> 0;
    };

    for (let i = 0; i < 200; i += 1) {
      const world = randomise(createWorld(i), 0xbeef + i);
      expect(hashWorld(world)).toBe(fnv(serialize(world)));
    }
  });

  it('is always an unsigned 32-bit integer', () => {
    for (let i = 0; i < 500; i += 1) {
      const hash = hashWorld(randomise(createWorld(i), i));
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(0x1_0000_0000);
    }
  });

  it('changes when any single slot changes', () => {
    // The property everything downstream leans on: there is no field you can
    // add to the world and forget to hash, because the hash walks the buffer.
    const base = createWorld(3, MAX_PLAYERS);
    const baseHash = hashWorld(base);

    for (let i = 0; i < WORLD_INT32S; i += 1) {
      const mutated = cloneWorld(base);
      mutated.data[i] = mutated.data[i] ^ 1;
      expect(hashWorld(mutated)).not.toBe(baseHash);
    }
  });
});

describe('step over the real world', () => {
  it('advances the tick and does not mutate its argument', () => {
    const before = createWorld(1);
    const beforeHash = hashWorld(before);

    const after = step(before, [0]);

    expect(getTick(after)).toBe(1);
    expect(getTick(before)).toBe(0);
    expect(hashWorld(before)).toBe(beforeHash);
  });

  it('records each player input so a dropped packet repeats rather than stalls', () => {
    const world = step(createWorld(1, 3), [0x11, 0x22, 0x33]);
    expect(getCar(world, 0, Car.LastInput)).toBe(0x11);
    expect(getCar(world, 1, Car.LastInput)).toBe(0x22);
    expect(getCar(world, 2, Car.LastInput)).toBe(0x33);
    // Slots beyond the player count are untouched.
    expect(getCar(world, 3, Car.LastInput)).toBe(0);
  });

  it('treats a missing input as zero rather than NaN', () => {
    const world = step(createWorld(1, 3), [0x11]);
    expect(getCar(world, 1, Car.LastInput)).toBe(0);
    expect(getCar(world, 2, Car.LastInput)).toBe(0);
  });

  it('produces an identical hash trail from an identical start', () => {
    const run = (): number[] => {
      let world = createWorld(0xabc, 2);
      const trail: number[] = [];
      for (let i = 0; i < 2_000; i += 1) {
        world = step(world, [i & 0xff, (i * 7) & 0xff]);
        if (i % 100 === 0) trail.push(hashWorld(world));
      }
      return trail;
    };

    expect(run()).toEqual(run());
  });

  it('survives a serialize/deserialize round-trip mid-run and continues identically', () => {
    // The M-10 resync path in miniature: a client that reconnects must land on
    // the same world the server is on and keep agreeing from there.
    let live = createWorld(0x5150, 2);
    for (let i = 0; i < 300; i += 1) live = step(live, [i & 0xff, 0]);

    let resumed = deserialize(serialize(live));
    expect(hashWorld(resumed)).toBe(hashWorld(live));

    for (let i = 300; i < 600; i += 1) {
      live = step(live, [i & 0xff, 0]);
      resumed = step(resumed, [i & 0xff, 0]);
    }
    expect(hashWorld(resumed)).toBe(hashWorld(live));
  });
});
