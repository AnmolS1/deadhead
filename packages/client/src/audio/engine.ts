/**
 * `audio/engine.ts` — the Web Audio plumbing, and nothing else.
 *
 * Every number this file uses comes from `policy.ts`. It exists to turn a
 * {@link Mix} into node parameters and to own the two things that can only be
 * got right in a real browser:
 *
 *  1. **The context must be created or resumed inside a real user gesture.**
 *     Autoplay policy leaves a context built at module scope `suspended`
 *     forever, and the failure is *silence with no error* — nothing throws,
 *     nothing logs, the game just has no sound. `attach()` is called from the
 *     first keydown/pointerdown and nowhere else.
 *  2. **Parameters ramp; they are never assigned.** A bare `gain.value = x`
 *     mid-playback is a discontinuity in the waveform and it clicks audibly. A
 *     click on every tick of the deadhead clock would read as a bug in the feel
 *     pass rather than as the feel pass.
 *
 * **No `fetch`, no `decodeAudioData`, no assets.** `C-07`'s brief specifies
 * that path; Anmol chose procedural synthesis instead, and it is strictly safer
 * on CSP rather than riskier — `fetch` + `decodeAudioData` is governed by
 * `connect-src 'self'`, while oscillators and an in-memory noise buffer make no
 * request at all. There is nothing for a policy to allow or deny. `<audio>`
 * elements remain out of the question either way: `media-src` is unset on the
 * site and falls back to `default-src 'none'`.
 */
import {
  AudioTuning,
  type AudioState,
  type Mix,
  clockPeriodSeconds,
  loadMuted,
  mixFor,
  saveMuted,
} from './policy.js';

/** How quickly a gain or pitch chases its target, in seconds. */
const RAMP_SECONDS = 0.08;

/**
 * Lookahead for the clock scheduler.
 *
 * Web Audio's clock is sample-accurate; `requestAnimationFrame` is not. Ticks
 * are therefore *scheduled ahead* on the audio clock rather than fired from the
 * render loop — a clock driven by rAF jitters with the frame rate, which is
 * audible on exactly the layer whose whole job is to be a steady beat.
 */
const SCHEDULE_AHEAD_SECONDS = 0.2;

interface Layer {
  readonly gain: GainNode;
}

/**
 * A short noise buffer, generated once.
 *
 * Used for the clock's transient. A filtered noise burst reads as a mechanical
 * tick; a pure sine reads as a beep, which sounds like a notification rather
 * than like time passing.
 */
function makeNoise(context: BaseAudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * 0.05);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x2545f491;
  for (let i = 0; i < length; i += 1) {
    // xorshift rather than Math.random: this is not sim state and does not need
    // to be deterministic, but a fixed noise burst means the tick sounds the
    // same every run, which a random one does not.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const decay = 1 - i / length;
    data[i] = ((seed & 0xffff) / 0x8000 - 1) * decay * decay;
  }
  return buffer;
}

export class AudioEngine {
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #music: Layer | null = null;
  #engine: Layer | null = null;
  #engineOsc: OscillatorNode | null = null;
  #clock: Layer | null = null;
  #noise: AudioBuffer | null = null;

  /** Next scheduled clock tick, on the audio clock. */
  #nextTickAt = 0;
  #lastMix: Mix | null = null;

  #muted: boolean;
  readonly #storage: Storage | null;

  constructor(storage: Storage | null) {
    this.#storage = storage;
    this.#muted = loadMuted(storage);
  }

  get muted(): boolean {
    return this.#muted;
  }

  /** Whether audio is actually running. False until the first user gesture. */
  get started(): boolean {
    return this.#context !== null && this.#context.state === 'running';
  }

  /**
   * Create and start the audio graph. **Must be called from a user-gesture
   * handler** — see the note at the top of this file.
   *
   * Idempotent, because it is wired to *every* first-input path (key, pointer,
   * touch) and several of them can fire for one gesture.
   */
  start(): void {
    if (this.#context !== null) {
      // A context can be suspended again by the browser (tab hidden, audio
      // focus lost). Resuming is also gesture-gated, so retry here rather than
      // assuming the first call stuck.
      void this.#context.resume();
      return;
    }

    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return; // No Web Audio. The game is still playable.

    const context = new Ctor();
    this.#context = context;
    this.#noise = makeNoise(context);

    const master = context.createGain();
    master.gain.value = this.#muted ? 0 : 1;
    master.connect(context.destination);
    this.#master = master;

    // --- music bed -------------------------------------------------------
    // Two detuned triangles a fifth apart. Deliberately plain: this is a bed
    // whose job is to be *missed* when it thins, not to be listened to.
    const music = context.createGain();
    music.gain.value = 0;
    music.connect(master);
    for (const [hz, detune] of [
      [98, -4],
      [147, 5],
    ] as const) {
      const osc = context.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = hz;
      osc.detune.value = detune;
      const voice = context.createGain();
      voice.gain.value = 0.5;
      osc.connect(voice).connect(music);
      osc.start();
    }
    this.#music = { gain: music };

    // --- engine ----------------------------------------------------------
    // A sawtooth through a lowpass. The filter tracks nothing; the pitch does
    // all the work, because pitch is what a player can hear against their own
    // throttle input.
    const engineGain = context.createGain();
    engineGain.gain.value = 0;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 900;
    const engineOsc = context.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = AudioTuning.engineIdleHz;
    engineOsc.connect(lowpass).connect(engineGain).connect(master);
    engineOsc.start();
    this.#engine = { gain: engineGain };
    this.#engineOsc = engineOsc;

    // --- deadhead clock --------------------------------------------------
    const clockGain = context.createGain();
    clockGain.gain.value = 0;
    clockGain.connect(master);
    this.#clock = { gain: clockGain };

    this.#nextTickAt = context.currentTime;
    void context.resume();
  }

  /** Toggle mute, persist it, and return the new state. */
  toggleMute(): boolean {
    this.#muted = !this.#muted;
    saveMuted(this.#storage, this.#muted);
    const master = this.#master;
    if (master !== null && this.#context !== null) {
      master.gain.setTargetAtTime(this.#muted ? 0 : 1, this.#context.currentTime, RAMP_SECONDS / 3);
    }
    return this.#muted;
  }

  /**
   * Push one frame of sim state into the mix.
   *
   * Safe to call before `start()` — it does nothing, so the render loop needs
   * no branch of its own.
   */
  update(state: AudioState): void {
    const context = this.#context;
    if (context === null || this.#master === null) return;

    const mix = mixFor(state);
    this.#lastMix = mix;
    const now = context.currentTime;

    // `setTargetAtTime`, never `.value =`. See the note at the top.
    this.#music?.gain.gain.setTargetAtTime(mix.music, now, RAMP_SECONDS);
    this.#engine?.gain.gain.setTargetAtTime(mix.engine, now, RAMP_SECONDS);
    this.#clock?.gain.gain.setTargetAtTime(mix.clock, now, RAMP_SECONDS);
    this.#engineOsc?.frequency.setTargetAtTime(mix.engineHz, now, RAMP_SECONDS);

    this.#scheduleClock(context, mix, now);
  }

  /**
   * Schedule any clock ticks falling inside the lookahead window.
   *
   * The `while` matters: at 4.5 Hz with a slow frame, more than one tick can be
   * due in a single call, and a scheduler that emits at most one per frame
   * silently loses beats exactly when the clock is fastest — which is when the
   * player is meant to be hearing it most clearly.
   */
  #scheduleClock(context: AudioContext, mix: Mix, now: number): void {
    const period = clockPeriodSeconds(mix);
    if (!Number.isFinite(period)) {
      // Clock silent (carrying, or eliminated). Re-baseline so the first tick
      // after a drop-off lands immediately rather than at whatever phase the
      // clock would have reached had it kept running.
      this.#nextTickAt = now;
      return;
    }

    if (this.#nextTickAt < now) this.#nextTickAt = now;

    while (this.#nextTickAt < now + SCHEDULE_AHEAD_SECONDS) {
      this.#tickAt(context, this.#nextTickAt);
      this.#nextTickAt += period;
    }
  }

  #tickAt(context: AudioContext, when: number): void {
    const clock = this.#clock;
    const noise = this.#noise;
    if (clock === null || noise === null) return;

    const source = context.createBufferSource();
    source.buffer = noise;

    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2200;
    band.Q.value = 6;

    source.connect(band).connect(clock.gain);
    source.start(when);
    source.stop(when + 0.06);
  }

  /** The last mix computed, for `C-08`'s renderer to stay in step with the ear. */
  get lastMix(): Mix | null {
    return this.#lastMix;
  }

  /** Release the audio hardware. */
  close(): void {
    const context = this.#context;
    this.#context = null;
    if (context !== null) void context.close();
  }
}
