import { describe, expect, it } from 'vitest';

import { INPUT_FORMAT_VERSION } from '../src/format.js';
import {
  INPUT_MASK,
  Input,
  MAX_INPUT_LOG_BYTES,
  MAX_INPUT_LOG_TICKS,
  decodeInputLog,
  encodeInputLog,
  hasInput,
  packInput,
} from '../src/input.js';

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

const roundTrip = (ticks: Uint8Array, seed = 1, startedAtMs = 0): Uint8Array =>
  decodeInputLog(encodeInputLog({ seed, startedAtMs, ticks })).ticks;

// ---------------------------------------------------------------------------

describe('packing one tick', () => {
  it('round-trips every flag', () => {
    for (const flag of Object.values(Input)) {
      expect(hasInput(packInput(flag), flag)).toBe(true);
    }
  });

  it('combines flags without collision', () => {
    const packed = packInput(Input.Throttle, Input.Right, Input.Handbrake);
    expect(hasInput(packed, Input.Throttle)).toBe(true);
    expect(hasInput(packed, Input.Right)).toBe(true);
    expect(hasInput(packed, Input.Handbrake)).toBe(true);
    expect(hasInput(packed, Input.Brake)).toBe(false);
    expect(hasInput(packed, Input.Left)).toBe(false);
  });

  it('assigns every flag a distinct bit inside one byte', () => {
    const flags = Object.values(Input);
    expect(new Set(flags).size).toBe(flags.length);
    for (const flag of flags) {
      expect(flag & INPUT_MASK).toBe(flag);
      expect(flag).toBeLessThan(256);
    }
  });

  it('drops undefined bits rather than carrying them into the log', () => {
    expect(packInput(0xff)).toBe(INPUT_MASK);
  });
});

describe('log round-trip', () => {
  it('is lossless over fuzzed input', () => {
    const rng = prng(0x1_9207);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const length = Math.abs(rng.next().value) % 3_000;
      const ticks = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) ticks[i] = rng.next().value & INPUT_MASK;

      expect(Array.from(roundTrip(ticks))).toEqual(Array.from(ticks));
    }
  });

  it('is lossless for held inputs, alternating inputs, and empty logs', () => {
    const held = new Uint8Array(14_400).fill(packInput(Input.Throttle, Input.Right));
    const alternating = Uint8Array.from({ length: 5_000 }, (_, i) => (i % 2 ? Input.Throttle : 0));
    const empty = new Uint8Array(0);

    for (const ticks of [held, alternating, empty]) {
      expect(Array.from(roundTrip(ticks))).toEqual(Array.from(ticks));
    }
  });

  it('preserves the seed and the client timestamp', () => {
    // The timestamp is not trusted and not used by the sim — B-07 compares it
    // against the server-minted token. It still has to survive the round trip.
    const startedAtMs = 1_800_000_000_000;
    const log = decodeInputLog(
      encodeInputLog({ seed: -12345, startedAtMs, ticks: new Uint8Array(10) }),
    );
    expect(log.seed).toBe(-12345);
    expect(log.startedAtMs).toBe(startedAtMs);
  });

  it('handles a timestamp beyond 32 bits of milliseconds', () => {
    // Milliseconds since epoch passed 2^32 in 1970 + 49 days. Carried as two
    // 32-bit halves because this format has no floats and no int64.
    for (const startedAtMs of [0, 0xffffffff, 0x1_0000_0000, 1_800_000_000_000]) {
      const log = decodeInputLog(
        encodeInputLog({ seed: 1, startedAtMs, ticks: new Uint8Array(4) }),
      );
      expect(log.startedAtMs).toBe(startedAtMs);
    }
  });

  it('stamps the format version', () => {
    expect(encodeInputLog({ seed: 1, startedAtMs: 0, ticks: new Uint8Array(4) })[0]).toBe(
      INPUT_FORMAT_VERSION,
    );
  });
});

describe('size', () => {
  it('encodes a realistic 8-minute run in well under 4 KB', () => {
    // S-12's done-when. A real player holds keys for many ticks at a stretch,
    // so runs are long and RLE is the right shape. 14,400 raw bytes at 30 Hz.
    const rng = prng(0xd1e5);
    const ticks = new Uint8Array(14_400);
    let held = packInput(Input.Throttle);
    for (let i = 0; i < ticks.length; i += 1) {
      // Change input roughly every ~15 ticks, which is a brisk half-second.
      if (Math.abs(rng.next().value) % 15 === 0) held = rng.next().value & INPUT_MASK;
      ticks[i] = held;
    }

    const encoded = encodeInputLog({ seed: 1, startedAtMs: 0, ticks });
    expect(encoded.length).toBeLessThan(4_096);
  });

  it('bounds even a pathological alternating log', () => {
    // The worst case for RLE: a different input every tick, two bytes each.
    // Still far inside the hard cap, which is what matters for B-07.
    const ticks = Uint8Array.from({ length: 14_400 }, (_, i) => i & INPUT_MASK);
    const encoded = encodeInputLog({ seed: 1, startedAtMs: 0, ticks });
    expect(encoded.length).toBeLessThan(MAX_INPUT_LOG_BYTES);
  });

  it('splits a hold longer than one count byte can carry', () => {
    const ticks = new Uint8Array(1_000).fill(Input.Throttle);
    const encoded = encodeInputLog({ seed: 1, startedAtMs: 0, ticks });
    // ceil(1000 / 255) = 4 runs, 2 bytes each.
    expect(encoded.length).toBe(20 + 8);
    expect(Array.from(roundTrip(ticks))).toEqual(Array.from(ticks));
  });
});

describe('rejection', () => {
  const valid = (): Uint8Array =>
    encodeInputLog({ seed: 1, startedAtMs: 0, ticks: new Uint8Array(100).fill(Input.Throttle) });

  it('refuses to encode more ticks than a run can contain', () => {
    expect(() =>
      encodeInputLog({ seed: 1, startedAtMs: 0, ticks: new Uint8Array(MAX_INPUT_LOG_TICKS + 1) }),
    ).toThrow(/ticks/);
  });

  it('rejects a buffer shorter than its header', () => {
    expect(() => decodeInputLog(new Uint8Array(4))).toThrow(/header/);
  });

  it('rejects an oversized buffer before doing any work', () => {
    expect(() => decodeInputLog(new Uint8Array(MAX_INPUT_LOG_BYTES + 1))).toThrow(/bytes/);
  });

  it('rejects a foreign format version', () => {
    const bytes = valid();
    bytes[0] = INPUT_FORMAT_VERSION + 1;
    expect(() => decodeInputLog(bytes)).toThrow(/format version/);
  });

  it('rejects a declared tick count that disagrees with the runs', () => {
    // Otherwise a log could claim 14,400 ticks and carry two, which would let a
    // submission assert a long run it never played.
    const short = valid();
    new DataView(short.buffer).setUint32(16, 500, true);
    expect(() => decodeInputLog(short)).toThrow(/carries/);

    const long = valid();
    new DataView(long.buffer).setUint32(16, 10, true);
    expect(() => decodeInputLog(long)).toThrow(/overrun/);
  });

  it('rejects a zero-length run', () => {
    // Encodes nothing and advances nothing. A decoder that tolerates it can be
    // made to loop forever on a hostile log.
    const bytes = valid();
    bytes[21] = 0;
    expect(() => decodeInputLog(bytes)).toThrow(/zero-length/);
  });

  it('rejects a truncated pair', () => {
    expect(() => decodeInputLog(valid().subarray(0, 21))).toThrow(/pairs/);
  });

  it('rejects a declared tick count past the cap', () => {
    const bytes = valid();
    new DataView(bytes.buffer).setUint32(16, MAX_INPUT_LOG_TICKS + 1, true);
    expect(() => decodeInputLog(bytes)).toThrow(/max/);
  });

  it('decodes from a buffer with a non-zero byteOffset', () => {
    // Network reads routinely hand you a slice of a larger buffer.
    const bytes = valid();
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 8);
    expect(decodeInputLog(padded.subarray(8)).ticks).toHaveLength(100);
  });
});
