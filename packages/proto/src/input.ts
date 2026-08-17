/**
 * `input.ts` — one tick of input in one byte, and the recorded log format.
 *
 * This is the format the whole integrity story rests on. Clients submit **input
 * logs, never scores** (`B-07`): the server re-runs the log through the same
 * `step()` and derives the score itself (`B-08`). Signing a score client-side
 * would be theatre — the secret would be in the bundle — whereas a log is
 * checkable, and checking it is just running the game.
 *
 * Storing logs turns out to hand you ghost racing (`G-07`), daily replays and a
 * determinism-regression alarm for free. That is `P-06`'s whole argument: pick
 * the representation that makes verification possible and the features fall out
 * of it.
 */
import { INPUT_FORMAT_VERSION } from './format.js';

/**
 * Input bits for one tick. Six used, two reserved — one byte per tick, and the
 * run-length encoding below turns a run of held keys into two bytes regardless
 * of how long it is held.
 */
export const Input = {
  Throttle: 1 << 0,
  Brake: 1 << 1,
  Left: 1 << 2,
  Right: 1 << 3,
  /** Cuts rear grip. Where the drift lives — see `car.ts`. */
  Handbrake: 1 << 4,
  /** Horn / hail. Reserved for `S-09`'s pickup interaction. */
  Hail: 1 << 5,
} as const;

/** Bits actually defined. Anything outside this mask is dropped on encode. */
export const INPUT_MASK = 0x3f;

/** True if `flag` is set in a packed input byte. */
export function hasInput(packed: number, flag: number): boolean {
  return (packed & flag) !== 0;
}

/** Combine flags into a packed byte, discarding undefined bits. */
export function packInput(...flags: readonly number[]): number {
  let packed = 0;
  for (const flag of flags) packed |= flag;
  return packed & INPUT_MASK;
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/** Bytes of fixed header before the run-length encoded stream. */
const HEADER_BYTES = 20;

/**
 * Hard ceiling on an encoded log. An 8-minute run at 30 Hz is 14,400 ticks —
 * two bytes per *run*, not per tick, so a realistic log is a few hundred bytes.
 * The cap is generous by two orders of magnitude and exists so `B-07` can reject
 * an oversized submission before doing any work on it.
 */
export const MAX_INPUT_LOG_BYTES = 64 * 1024;

/** ~20 minutes at 30 Hz. A run longer than this is not a run. */
export const MAX_INPUT_LOG_TICKS = 36_000;

export interface InputLog {
  /** Seed the run was played on. Minted server-side in `B-06`; the client cannot choose it. */
  readonly seed: number;
  /**
   * Wall-clock milliseconds at tick 0, as reported by the client.
   *
   * **Not trusted, and not used by the sim.** `B-07` compares it against the
   * server-minted token to reject a log that claims to have been played faster
   * than 14,400 ticks physically allow. Carried as two 32-bit halves because
   * milliseconds since epoch does not fit in an `int32` and this format has no
   * floats.
   */
  readonly startedAtMs: number;
  /** One packed byte per tick, in order. */
  readonly ticks: Uint8Array;
}

/**
 * Encode a log: fixed header, then `(value, count)` pairs.
 *
 * Run-length encoding is the right shape here rather than a clever one: input
 * is held down for many consecutive ticks, so runs are long, and the encoder is
 * simple enough to be obviously correct — which matters more than ratio for
 * something the anti-cheat path depends on.
 */
export function encodeInputLog(log: InputLog): Uint8Array {
  if (log.ticks.length > MAX_INPUT_LOG_TICKS) {
    throw new RangeError(`input log has ${log.ticks.length} ticks, max ${MAX_INPUT_LOG_TICKS}`);
  }

  const runs: number[] = [];
  let index = 0;
  while (index < log.ticks.length) {
    const value = (log.ticks[index] as number) & INPUT_MASK;
    let count = 1;
    // 255 is the largest count one byte can carry; a longer hold simply
    // starts another run.
    while (
      count < 255 &&
      index + count < log.ticks.length &&
      ((log.ticks[index + count] as number) & INPUT_MASK) === value
    ) {
      count += 1;
    }
    runs.push(value, count);
    index += count;
  }

  const bytes = new Uint8Array(HEADER_BYTES + runs.length);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, INPUT_FORMAT_VERSION);
  // Bytes 1..3 reserved, left zero.
  view.setUint32(4, log.seed >>> 0, true);
  view.setUint32(8, Math.floor(log.startedAtMs / 0x1_0000_0000) >>> 0, true);
  view.setUint32(12, log.startedAtMs >>> 0, true);
  view.setUint32(16, log.ticks.length, true);
  bytes.set(runs, HEADER_BYTES);

  if (bytes.length > MAX_INPUT_LOG_BYTES) {
    throw new RangeError(`encoded log is ${bytes.length} bytes, max ${MAX_INPUT_LOG_BYTES}`);
  }

  return bytes;
}

/**
 * Decode a log, rejecting anything that is not one.
 *
 * Every check here guards a public submission endpoint, so each exists because
 * the alternative is the validator doing work on nonsense:
 *
 * - **Oversized** — rejected before allocating anything.
 * - **Wrong version** — the reason `INPUT_FORMAT_VERSION` exists.
 * - **Declared tick count disagreeing with the runs** — otherwise a log could
 *   claim 14,400 ticks and carry two, or claim two and carry 14,400.
 * - **A zero-length run** — encodes nothing, advances nothing, and a decoder
 *   that tolerates it can be made to loop forever.
 */
export function decodeInputLog(bytes: Uint8Array): InputLog {
  if (bytes.length > MAX_INPUT_LOG_BYTES) {
    throw new RangeError(`input log is ${bytes.length} bytes, max ${MAX_INPUT_LOG_BYTES}`);
  }
  if (bytes.length < HEADER_BYTES) {
    throw new RangeError(`input log is ${bytes.length} bytes, shorter than its header`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const version = view.getUint8(0);
  if (version !== INPUT_FORMAT_VERSION) {
    throw new RangeError(`input log format version ${version}, expected ${INPUT_FORMAT_VERSION}`);
  }

  const seed = view.getUint32(4, true) | 0;
  const startedAtMs = view.getUint32(8, true) * 0x1_0000_0000 + view.getUint32(12, true);
  const tickCount = view.getUint32(16, true);

  if (tickCount > MAX_INPUT_LOG_TICKS) {
    throw new RangeError(`input log declares ${tickCount} ticks, max ${MAX_INPUT_LOG_TICKS}`);
  }

  const body = bytes.length - HEADER_BYTES;
  if (body % 2 !== 0) {
    throw new RangeError('input log body is not a whole number of (value, count) pairs');
  }

  const ticks = new Uint8Array(tickCount);
  let written = 0;
  for (let offset = HEADER_BYTES; offset < bytes.length; offset += 2) {
    const value = (bytes[offset] as number) & INPUT_MASK;
    const count = bytes[offset + 1] as number;

    if (count === 0) throw new RangeError('input log contains a zero-length run');
    if (written + count > tickCount) {
      throw new RangeError('input log runs overrun its declared tick count');
    }

    ticks.fill(value, written, written + count);
    written += count;
  }

  if (written !== tickCount) {
    throw new RangeError(`input log declares ${tickCount} ticks but carries ${written}`);
  }

  return { seed, startedAtMs, ticks };
}
