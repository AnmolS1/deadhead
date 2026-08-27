/**
 * `audio/policy.ts` — every decision the audio layer makes, as pure functions.
 *
 * **Why this file exists separately from `engine.ts`.** Web Audio exists in
 * neither node nor `workerd`, so anything expressed as `AudioNode` wiring is
 * untestable by this repo's standards — and "I listened to it once" is not a
 * regression test. Everything with a judgement in it lives here as arithmetic
 * over sim state, and `engine.ts` is left thin enough to check by ear.
 *
 * Nothing here touches `AudioContext`, `window`, or time. Given the same world
 * numbers it returns the same mix, which is also what makes the `C-08` feel
 * pass tunable without a browser in the loop.
 */
import { ClockTuning, TICK_HZ } from '@deadhead/sim';

/**
 * The mix, as gains in [0, 1] and a clock rate in Hz.
 *
 * One struct rather than four getters so a test can assert the *whole* mix for
 * a given state. A per-parameter API lets a caller read three of the four and
 * miss that the fourth never changed — which is precisely how a feel pass ships
 * with its most important layer silent.
 */
export interface Mix {
  /** The music bed. Full when carrying, near-silent when empty. */
  readonly music: number;
  /** The engine note. Independent of fare state — the cab is always running. */
  readonly engine: number;
  /** The deadhead clock. Silent when carrying; that silence *is* the mechanic. */
  readonly clock: number;
  /** Clock ticks per second. Zero when the clock is silent. */
  readonly clockHz: number;
  /** Engine pitch in Hz. */
  readonly engineHz: number;
}

export const AudioTuning = {
  /**
   * Music gain while carrying, and while empty.
   *
   * **Not zero when empty.** `DESIGN.md` says the music "thins to near-silence",
   * and the difference matters: silence reads as the audio breaking, while a
   * thin remaining thread reads as something being *taken away* and still
   * running out. It also leaves somewhere to go — the bed does not have to fade
   * back in from nothing when a fare starts, which would sound like a bug.
   */
  musicCarrying: 0.55,
  musicEmpty: 0.06,

  /** Engine gain. Constant: the cab is running either way. */
  engine: 0.18,

  /** Deadhead clock gain when audible. */
  clock: 0.3,

  /** Engine pitch at a standstill, and at the speed below. */
  engineIdleHz: 62,
  engineMaxHz: 190,

  /**
   * Speed, in world units per tick, at which the engine note reaches
   * `engineMaxHz`. Above it the pitch holds rather than climbing forever.
   *
   * Derived by ear against `CarTuning`'s top speed rather than restated from
   * it: the note should still be rising through normal driving, so it tops out
   * a little above what a cab reaches on a straight.
   */
  engineTopSpeed: 0.55,

  /**
   * Clock rate at a full bank, and at an empty one.
   *
   * A slow tick that roughly doubles is the whole readable signal. Faster than
   * ~5 Hz stops reading as a clock and starts reading as a buzz, which is the
   * opposite of legible.
   */
  clockSlowHz: 1.0,
  clockFastHz: 4.5,
} as const;

/** Clamp to [0, 1]. */
function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * How much of the deadhead bank is left, in [0, 1].
 *
 * Reads `ClockTuning.startingDeadheadTicks` rather than restating 180 seconds.
 * `DESIGN.md` §7 flags that number as *inherited, not designed* and expects it
 * to move; when it does, the audio follows without anyone remembering to come
 * here. That is habit #1 in `HANDOFF.md` and it is why this takes a parameter
 * it could have hardcoded.
 */
export function bankFraction(deadheadTicks: number): number {
  const full = ClockTuning.startingDeadheadTicks;
  if (full <= 0) return 0;
  return unit(deadheadTicks / full);
}

/**
 * Engine pitch for a speed in world units per tick.
 *
 * Linear in speed, which is wrong for a real engine and right here: the note is
 * a speed *readout*, not an engine simulation, and a linear map is the one a
 * player can learn in a corner.
 */
export function engineHz(speedPerTick: number): number {
  const { engineIdleHz, engineMaxHz, engineTopSpeed } = AudioTuning;
  const t = unit(Math.abs(speedPerTick) / engineTopSpeed);
  return engineIdleHz + (engineMaxHz - engineIdleHz) * t;
}

/**
 * Clock rate for a remaining bank.
 *
 * Accelerates as the bank drains, so `bank = 1` is the slowest tick. The curve
 * is squared in the *remaining* fraction, which spends most of its acceleration
 * in the last third of a run — an evenly-accelerating clock is nearly flat
 * where it matters and the ending arrives without warning.
 */
export function clockHz(bank: number): number {
  const { clockSlowHz, clockFastHz } = AudioTuning;
  const remaining = unit(bank);
  const urgency = (1 - remaining) ** 2;
  return clockFastHz + (clockSlowHz - clockFastHz) * (1 - urgency);
}

/** State the mix is derived from. Exactly the sim fields it needs, no world. */
export interface AudioState {
  readonly carrying: boolean;
  /** `Car.DeadheadTicks`. */
  readonly deadheadTicks: number;
  /** Magnitude of the velocity vector, world units per tick. */
  readonly speedPerTick: number;
  /** `CarFlags.Eliminated` — the run is over for this cab. */
  readonly eliminated: boolean;
}

/**
 * The whole mix for one moment.
 *
 * **The clock is silent while carrying, and that is the mechanic.** `C-08`'s
 * pass condition is a player articulating "the timer stops when someone's in
 * the car" — they can only articulate it if something audibly stops. A clock
 * that merely slows down when carrying would be a worse signal than no clock,
 * because it says "this still matters" while meaning the opposite.
 */
export function mixFor(state: AudioState): Mix {
  // An eliminated cab is off the board — `scene.ts` stops drawing it. Leaving
  // the engine running under a car that is no longer there is the audio version
  // of the same bug.
  if (state.eliminated) {
    return { music: 0, engine: 0, clock: 0, clockHz: 0, engineHz: AudioTuning.engineIdleHz };
  }

  const bank = bankFraction(state.deadheadTicks);

  return {
    music: state.carrying ? AudioTuning.musicCarrying : AudioTuning.musicEmpty,
    engine: AudioTuning.engine,
    clock: state.carrying ? 0 : AudioTuning.clock,
    clockHz: state.carrying ? 0 : clockHz(bank),
    engineHz: engineHz(state.speedPerTick),
  };
}

/** Seconds per clock tick, for a scheduler. `Infinity` when the clock is silent. */
export function clockPeriodSeconds(mix: Mix): number {
  return mix.clockHz > 0 ? 1 / mix.clockHz : Infinity;
}

/** Ticks per second the sim runs at, re-exported so `engine.ts` need not import the sim. */
export const SIM_HZ = TICK_HZ;

const MUTE_STORAGE_KEY = 'deadhead.audio.muted';

/**
 * Read the persisted mute flag.
 *
 * Follows `input/bindings.ts`: a storage that throws on access — which is what
 * `localStorage` does in some privacy modes, rather than returning null — must
 * fall back to the default rather than taking the page down with it.
 */
export function loadMuted(storage: Storage | null | undefined): boolean {
  if (storage === null || storage === undefined) return false;
  try {
    return storage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the mute flag. Silently does nothing if storage is unavailable. */
export function saveMuted(storage: Storage | null | undefined, muted: boolean): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    // Quota or privacy mode. A preference that fails to persist is not worth
    // an exception that stops the game.
  }
}
