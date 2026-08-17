import { describe, expect, it } from 'vitest';

import { CITY_FORMAT_VERSION } from '../src/format.js';
import {
  CityCaps,
  EdgeFlags,
  NO_NAME,
  cityContentHash,
  cityName,
  emptyCityJson,
  foldCityHashIntoSeed,
  packCity,
  unpackCity,
  validateCity,
  type CityEdge,
  type CityJson,
} from '../src/city.js';
import { FX_ONE, WORLD_MAX } from '../src/space.js';

/**
 * The hand-written four-block test city that `W-01`'s done-when calls for.
 *
 * A 2x2 grid of blocks: nine junctions, roads between them, a building in each
 * block, a pavement spawn and a destination per corner, one demand anchor and a
 * named landmark. Small enough to reason about by hand, complete enough that
 * every section of the format is exercised.
 *
 * ```text
 *      0      40     80
 *   80 6------7------8
 *      |  [B] |  [B] |
 *   40 3------4------5
 *      |  [B] |  [B] |
 *    0 0------1------2
 * ```
 */
function fourBlockCity(): CityJson {
  const grid = [0, 40, 80];
  const nodes = grid.flatMap((y, row) => grid.map((x) => ({ x, y, name: row === 0 ? 0 : 1 })));

  const edges: CityEdge[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const index = row * 3 + col;
      if (col < 2) edges.push({ a: index, b: index + 1, width: 8 });
      if (row < 2) edges.push({ a: index, b: index + 3, width: 8 });
    }
  }
  // One of them is a one-way, because W-03 wants them and the format has to
  // carry the flag before the city can use it.
  edges.push({ a: 1, b: 4, width: 8, flags: EdgeFlags.OneWay });

  return {
    ...emptyCityJson('four blocks'),
    nodes,
    edges,
    buildings: [
      { minX: 8, minY: 8, maxX: 32, maxY: 32 },
      { minX: 48, minY: 8, maxX: 72, maxY: 32 },
      { minX: 8, minY: 48, maxX: 32, maxY: 72 },
      { minX: 48, minY: 48, maxX: 72, maxY: 72 },
    ],
    spawns: [
      { x: 6, y: 20 },
      { x: 34, y: 60 },
      { x: 74, y: 20 },
    ],
    destinations: [
      { x: 20, y: 6 },
      { x: 60, y: 74 },
    ],
    demandAnchors: [{ x: 40, y: 40, radius: 30, phase: 128 }],
    landmarks: [{ x: 40, y: 40, name: 2 }],
    names: ['Wharf Street', 'Crease Row', 'The Fold'],
  };
}

// ---------------------------------------------------------------------------

describe('the four-block test city', () => {
  it('packs, unpacks and validates', () => {
    // W-01's done-when, in one assertion.
    const packed = packCity(fourBlockCity());
    expect(() => validateCity(packed)).not.toThrow();
  });

  it('round-trips every section', () => {
    const json = fourBlockCity();
    const packed = unpackCity(packCity(json).bytes);

    expect(packed.nodes.length / 3).toBe(json.nodes.length);
    expect(packed.edges.length / 4).toBe(json.edges.length);
    expect(packed.buildings.length / 4).toBe(json.buildings.length);
    expect(packed.spawns.length / 4).toBe(json.spawns.length);
    expect(packed.destinations.length / 4).toBe(json.destinations.length);
    expect(packed.demandAnchors.length / 4).toBe(json.demandAnchors.length);
    expect(packed.landmarks.length / 4).toBe(json.landmarks.length);
    expect(packed.nameBytes).toHaveLength(json.names.length);
  });

  it('converts whole units to 16.16 exactly', () => {
    const packed = packCity(fourBlockCity());
    // First building is [8, 8, 32, 32].
    expect(packed.buildings[0]).toBe(8 * FX_ONE);
    expect(packed.buildings[2]).toBe(32 * FX_ONE);
    // First node is the origin.
    expect(packed.nodes[0]).toBe(0);
    expect(packed.nodes[1]).toBe(0);
  });

  it('preserves one-way flags and edge topology', () => {
    const packed = packCity(fourBlockCity());
    const oneWays: number[] = [];
    for (let i = 0; i < packed.edges.length; i += 4) {
      if (((packed.edges[i + 3] as number) & EdgeFlags.OneWay) !== 0) oneWays.push(i / 4);
    }
    expect(oneWays).toHaveLength(1);
    expect(packed.edges[(oneWays[0] as number) * 4]).toBe(1);
    expect(packed.edges[(oneWays[0] as number) * 4 + 1]).toBe(4);
  });

  it('decodes names only when asked', () => {
    // nameBytes stays raw so the replay validator never pays to decode street
    // names it has no use for.
    const packed = packCity(fourBlockCity());
    expect(packed.nameBytes[0]).toBeInstanceOf(Uint8Array);
    expect(cityName(packed, 0)).toBe('Wharf Street');
    expect(cityName(packed, 2)).toBe('The Fold');
  });

  it('handles names outside ASCII', () => {
    const json = { ...emptyCityJson('unicode'), names: ['Grüner Weg', '折り紙通り', 'Café'] };
    const packed = packCity(json);
    expect(cityName(packed, 0)).toBe('Grüner Weg');
    expect(cityName(packed, 1)).toBe('折り紙通り');
    expect(cityName(packed, 2)).toBe('Café');
  });

  it('is small', () => {
    // Sanity on the format's density. A real city (W-03) is larger, but an
    // order of magnitude matters for what ships to the browser.
    expect(packCity(fourBlockCity()).bytes.byteLength).toBeLessThan(1024);
  });
});

describe('determinism of packing', () => {
  it('produces identical bytes for identical input', () => {
    const a = packCity(fourBlockCity());
    const b = packCity(fourBlockCity());
    expect(Array.from(b.bytes)).toEqual(Array.from(a.bytes));
    expect(b.contentHash).toBe(a.contentHash);
  });

  it('writes little-endian regardless of host byte order', () => {
    const packed = packCity({
      ...emptyCityJson(),
      buildings: [{ minX: 1, minY: 0, maxX: 2, maxY: 1 }],
    });
    // 1.0 in 16.16 is 0x00010000, which is 00 00 01 00 little-endian.
    const at = 64;
    expect(Array.from(packed.bytes.subarray(at, at + 4))).toEqual([0x00, 0x00, 0x01, 0x00]);
  });
});

describe('the content hash', () => {
  it('changes when any field changes', () => {
    const base = packCity(fourBlockCity()).contentHash;

    const movedBuilding = fourBlockCity();
    const nudged = packCity({
      ...movedBuilding,
      buildings: [{ minX: 8, minY: 8, maxX: 33, maxY: 32 }, ...movedBuilding.buildings.slice(1)],
    });
    expect(nudged.contentHash).not.toBe(base);

    const renamed = packCity({ ...fourBlockCity(), names: ['Wharf St', 'Crease Row', 'The Fold'] });
    expect(renamed.contentHash).not.toBe(base);
  });

  it('covers the bytes it claims to and no others', () => {
    const packed = packCity(fourBlockCity());
    expect(cityContentHash(packed.bytes)).toBe(packed.contentHash);
  });

  it('is detected if the bytes are tampered with', () => {
    const packed = packCity(fourBlockCity());
    const tampered = Uint8Array.from(packed.bytes);
    tampered[100] = (tampered[100] as number) ^ 0xff;
    expect(() => validateCity(unpackCity(tampered))).toThrow(/content hash/);
  });
});

describe('folding the city hash into the run seed', () => {
  it('makes the same seed on a different city a different run', () => {
    // ADR 0005. This is what invalidates old leaderboard entries when the city
    // is edited, rather than silently replaying them against moved geometry.
    const a = packCity(fourBlockCity()).contentHash;
    const b = packCity({
      ...fourBlockCity(),
      buildings: [{ minX: 8, minY: 8, maxX: 33, maxY: 32 }],
    }).contentHash;

    expect(foldCityHashIntoSeed(1234, a)).not.toBe(foldCityHashIntoSeed(1234, b));
  });

  it('is deterministic and returns an int32', () => {
    for (const seed of [0, 1, -1, 0x7fffffff, -0x80000000]) {
      for (const hash of [0, 1, 0xffffffff, 0x235ffdba]) {
        const folded = foldCityHashIntoSeed(seed, hash);
        expect(folded).toBe(foldCityHashIntoSeed(seed, hash));
        expect(Object.is(folded, folded | 0)).toBe(true);
      }
    }
  });

  it('has no identity case, so there is one rule and no exception', () => {
    // A zero hash is still mixed. Special-casing it would mean "the run seed is
    // a function of both inputs, except sometimes".
    expect(foldCityHashIntoSeed(1234, 0)).not.toBe(1234);
  });

  it('separates neighbouring seeds and neighbouring hashes', () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 1_000; i += 1) seeds.add(foldCityHashIntoSeed(i, 0xabcdef));
    expect(seeds.size).toBe(1_000);

    const hashes = new Set<number>();
    for (let i = 0; i < 1_000; i += 1) hashes.add(foldCityHashIntoSeed(42, i));
    expect(hashes.size).toBe(1_000);
  });
});

describe('rejection', () => {
  const valid = (): Uint8Array => packCity(fourBlockCity()).bytes;

  it('rejects a file that is not a city', () => {
    const bytes = valid();
    bytes[0] = 0;
    expect(() => unpackCity(bytes)).toThrow(/magic/);
  });

  it('rejects a foreign format version', () => {
    const bytes = valid();
    new DataView(bytes.buffer).setUint32(4, CITY_FORMAT_VERSION + 1, true);
    expect(() => unpackCity(bytes)).toThrow(/format version/);
  });

  it('rejects a buffer shorter than its header', () => {
    expect(() => unpackCity(new Uint8Array(8))).toThrow(/header/);
  });

  it('rejects an oversized buffer before parsing it', () => {
    expect(() => unpackCity(new Uint8Array(CityCaps.bytes + 1))).toThrow(/max/);
  });

  it('rejects a count that would overrun the buffer', () => {
    // Otherwise a section reads past the end and validates as a legitimate city.
    const bytes = valid();
    new DataView(bytes.buffer).setUint32(3 * 4, 500, true);
    expect(() => unpackCity(bytes)).toThrow(/header describes/);
  });

  it('rejects a count past its cap', () => {
    const bytes = valid();
    new DataView(bytes.buffer).setUint32(3 * 4, CityCaps.nodes + 1, true);
    expect(() => unpackCity(bytes)).toThrow(/max/);
  });

  it('refuses to pack more than a cap allows', () => {
    expect(() =>
      packCity({
        ...emptyCityJson(),
        landmarks: Array.from({ length: CityCaps.landmarks + 1 }, () => ({ x: 0, y: 0 })),
      }),
    ).toThrow(/landmarks/);
  });

  it('rejects an edge pointing at a node that does not exist', () => {
    const packed = packCity({
      ...emptyCityJson(),
      nodes: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      edges: [{ a: 0, b: 5, width: 8 }],
    });
    expect(() => validateCity(packed)).toThrow(/references node 5/);
  });

  it('rejects a self-loop edge', () => {
    const packed = packCity({
      ...emptyCityJson(),
      nodes: [{ x: 0, y: 0 }],
      edges: [{ a: 0, b: 0, width: 8 }],
    });
    expect(() => validateCity(packed)).toThrow(/self-loop/);
  });

  it('rejects a zero-width road', () => {
    const packed = packCity({
      ...emptyCityJson(),
      nodes: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      edges: [{ a: 0, b: 1, width: 0 }],
    });
    expect(() => validateCity(packed)).toThrow(/width/);
  });

  it('rejects coordinates outside the fixed-point envelope', () => {
    // The city format is the last place this can be caught before the sim tries
    // to do arithmetic on it. See ADR 0003.
    const packed = packCity({
      ...emptyCityJson(),
      buildings: [{ minX: 0, minY: 0, maxX: WORLD_MAX + 10, maxY: 10 }],
    });
    expect(() => validateCity(packed)).toThrow(/outside/);
  });

  it('rejects an inverted or degenerate building', () => {
    for (const box of [
      { minX: 10, minY: 0, maxX: 5, maxY: 10 },
      { minX: 10, minY: 0, maxX: 10, maxY: 10 },
    ]) {
      expect(() => validateCity(packCity({ ...emptyCityJson(), buildings: [box] }))).toThrow(
        /inverted or degenerate/,
      );
    }
  });

  it('rejects a name index that does not exist', () => {
    const packed = packCity({
      ...emptyCityJson(),
      landmarks: [{ x: 0, y: 0, name: 3 }],
      names: ['only one'],
    });
    expect(() => validateCity(packed)).toThrow(/references name 3/);
  });

  it('accepts NO_NAME everywhere a name is optional', () => {
    const packed = packCity({
      ...emptyCityJson(),
      nodes: [{ x: 0, y: 0 }],
      landmarks: [{ x: 1, y: 1 }],
      spawns: [{ x: 2, y: 2 }],
    });
    expect(packed.landmarks[2]).toBe(NO_NAME);
    expect(() => validateCity(packed)).not.toThrow();
  });

  it('accepts an entirely empty city', () => {
    expect(() => validateCity(packCity(emptyCityJson()))).not.toThrow();
  });

  it('unpacks from a buffer with a non-zero byteOffset', () => {
    const bytes = valid();
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 8);
    expect(() => validateCity(unpackCity(padded.subarray(8)))).not.toThrow();
  });
});
