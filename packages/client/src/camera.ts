/**
 * `camera.ts` — where the view is, and how it gets there.
 *
 * Four behaviours, one object: follow the cab with a velocity lead, widen the
 * view as it goes faster, optionally rotate so the cab points up the screen,
 * and shake on a crash.
 *
 * Everything here is float, and none of it ever reaches the sim. The camera
 * reads a pose and returns a view; it holds no reference to a `World` between
 * calls and has no method that writes one. Delete this file and every recorded
 * replay still hashes identically — `camera.test.ts` asserts exactly that, and
 * it is the property that makes it safe for the camera to be as loose and as
 * frame-dependent as it likes.
 *
 * ## Why it takes a pose and not a world
 *
 * `C-03`'s done-when is "smooth at 30 Hz sim / 144 Hz render". A camera that
 * read the world directly would be sampling tick-quantised positions, so its
 * own target would step 30 times a second no matter how fast the display ran —
 * and the smoothing only hides that if the smoothing is slow, which is the
 * thing this task exists to avoid. So `update` takes a {@link CameraTarget} of
 * plain floats and `C-05` hands it the *interpolated* pose it is already
 * computing for the renderer. {@link cameraTargetFromCar} is the
 * un-interpolated path, for `C-06`'s overlay and for before `C-05` lands.
 *
 * ## Frame-rate independence
 *
 * Every smoothed channel uses `1 - exp(-elapsed / tau)`, never a fixed fraction
 * per frame. The distinction is not cosmetic: `x += (target - x) * 0.1` moves
 * the camera 2.4x faster at 144 Hz than at 60 Hz, which is a different game on
 * a different monitor and makes `C-05`'s side-by-side capture meaningless. The
 * exponential form is exact — over a fixed wall-clock duration the product of
 * the per-frame `(1 - a)` factors is `exp(-total / tau)` however that duration
 * is chopped up.
 */
import { Car, FX_ONE, TURN, carSpeedFraction, getCar, type World } from '@deadhead/sim';

const TAU_RADIANS = Math.PI * 2;

/**
 * Every constant the feel of the camera depends on, in one place, mirroring
 * `CarTuning` — `C-06` puts sliders on this and pastes the result back.
 *
 * Distances are world units (the cab is about 2.2 units long), times are
 * milliseconds, and every rate is a time constant rather than a per-frame
 * fraction. See the header for why that matters.
 */
export const CameraTuning = {
  /**
   * How far ahead of the cab to look, in **sim ticks** of travel.
   *
   * The lead is `velocity × this`, and velocity is units per *tick* because
   * that is what the sim stores. At top speed (one unit/tick) twelve ticks is
   * about five car lengths of road, bought at the cost of the same amount
   * behind — which is the trade the whole idea rests on, since the player needs
   * to read the junction they are arriving at, not the one they just left.
   */
  lookaheadTicks: 12,

  /** Hard cap on the lead, in world units, so nothing can push the cab offscreen. */
  maxLookahead: 14,

  /** Time constant for the follow. Short: the camera should feel attached, not towed. */
  followTauMs: 120,

  /** Time constant for zoom. Long: a zoom that reacts as fast as position reads as breathing. */
  zoomTauMs: 320,

  /** Time constant for rotation-to-heading. */
  rotationTauMs: 180,

  /** View scale at a standstill. The renderer multiplies its own pixels-per-unit by this. */
  restZoom: 1,

  /** View scale at top speed. Below `restZoom`, so faster means *more* road visible. */
  fastZoom: 0.78,

  /** Default peak shake displacement for a crash, in world units. */
  crashShake: 1.25,

  /** Time constant for shake decay. Four of these is 0.7 s, about as long as a hit should ring. */
  shakeDecayTauMs: 180,

  /** Below this peak displacement the shake is switched off rather than left ringing forever. */
  shakeMinAmplitude: 0.01,

  /**
   * Frequency band for the shake, in Hz. Two components per axis are drawn from
   * this band. Below about 8 Hz a shake reads as the camera being broken rather
   * than as an impact; above about 18 Hz it stops being legible at 60 Hz at all.
   *
   * Far away from `G-09`'s "no flashing above 3 Hz" in the other direction —
   * that rule is about luminance, and shake is switched off outright under
   * `prefers-reduced-motion` regardless.
   */
  shakeMinHz: 9,
  shakeMaxHz: 17,
} as const;

/** `localStorage` key for the rotation toggle, namespaced so the site's other pages cannot collide. */
export const ROTATION_STORAGE_KEY = 'deadhead.camera.rotation';

/**
 * The pose the camera is following.
 *
 * All floats, all world units. `velocityX`/`velocityY` are **units per tick**,
 * matching what the sim stores — a caller that assumed units per second would
 * lead by thirty times too much, and the mistake would be tuned around rather
 * than found.
 */
export interface CameraTarget {
  readonly x: number;
  readonly y: number;
  readonly velocityX: number;
  readonly velocityY: number;
  /** Where the cab points, in radians. Not the direction of travel — that is where `S-06`'s drift lives. */
  readonly heading: number;
  /** Speed as a fraction of the cab's maximum, clamped to `[0, 1]`. Drives the zoom. */
  readonly speedFraction: number;
}

/**
 * Where to draw from, this frame.
 *
 * The renderer applies it in exactly this order, and the order is the contract:
 *
 * ```js
 * ctx.translate(width / 2, height / 2);
 * ctx.rotate(-view.rotation);
 * ctx.scale(view.zoom * pixelsPerUnit, view.zoom * pixelsPerUnit);
 * ctx.translate(-view.x, -view.y);
 * ```
 *
 * The negated rotation is not a typo. `rotation` is the world-space angle that
 * ends up pointing at the top of the screen, so drawing it means rotating the
 * world by its inverse. Writing the sequence down here rather than exporting a
 * `worldToScreen` is deliberate: `C-04` owns the transform, and a second copy
 * of it living in this file is a thing that drifts.
 */
export interface CameraView {
  /** Centre of the view, in world units, with {@link CameraView.shakeX} already added. */
  readonly x: number;
  readonly y: number;
  /** The shake contribution included in `x`/`y`. Subtract it to recover the smoothed centre. */
  readonly shakeX: number;
  readonly shakeY: number;
  /** Multiplier on the renderer's pixels-per-unit. Below 1 means a wider view. */
  readonly zoom: number;
  /** Radians, always normalised to `(-π, π]`. Zero when rotation is off. */
  readonly rotation: number;
}

/** The two `localStorage` methods this file uses, so a test can pass an object literal. */
export interface CameraStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CameraOptions {
  /**
   * Seed for the shake's frequency and phase draws.
   *
   * A fixed constant by default, never anything ambient. Two playbacks of one
   * replay have to shake identically or `C-05`'s A/B capture is comparing noise
   * and "did that change feel better" stops being an answerable question.
   */
  readonly seed?: number;

  /**
   * Where the rotation toggle is persisted. Defaults to `localStorage` when it
   * is reachable and to nothing at all when it is not — see {@link probeStorage}.
   */
  readonly storage?: CameraStorage;

  /**
   * Whether the user has asked for reduced motion.
   *
   * A predicate rather than a boolean because the setting can change mid-session
   * and `G-09` asks for it to be honoured, not for it to be honoured only at
   * load. Defaults to a live read of `prefers-reduced-motion`.
   */
  readonly reducedMotion?: () => boolean;

  /**
   * Rotation-to-heading when nothing has been persisted yet.
   *
   * **Off.** A rotating camera makes a meaningful number of people motion-sick,
   * and the setting that does that should be the one you opt into rather than
   * the one you discover you need to turn off. `G-09` lists it next to the
   * reduced-motion work for the same reason.
   */
  readonly rotationDefault?: boolean;
}

/**
 * Read the pose of one cab straight out of the sim.
 *
 * Fixed point goes in, floats come out, and nothing goes back. Prefer `C-05`'s
 * interpolated pose for the real camera; this is for `C-06`'s overlay, for
 * tests, and for the app shell until `C-05` exists.
 */
export function cameraTargetFromCar(world: World, slot: number): CameraTarget {
  return {
    x: getCar(world, slot, Car.X) / FX_ONE,
    y: getCar(world, slot, Car.Y) / FX_ONE,
    velocityX: getCar(world, slot, Car.VelocityX) / FX_ONE,
    velocityY: getCar(world, slot, Car.VelocityY) / FX_ONE,
    // Headings are a uint16 turn, so a whole circle divides exactly and there
    // is no wrap special case to get wrong on the way out.
    heading: ((getCar(world, slot, Car.Heading) & 0xffff) / TURN) * TAU_RADIANS,
    speedFraction: carSpeedFraction(world, slot) / FX_ONE,
  };
}

/**
 * The follow camera.
 *
 * Holds float state, is driven by wall-clock milliseconds, and sits entirely
 * downstream of the simulation. Takes elapsed times and plain numbers so it can
 * be driven by a synthetic 144 Hz display with no browser anywhere, the same
 * way `FixedTimestepLoop` is.
 */
export class Camera {
  /** Smoothed centre, before shake. */
  private centreX = 0;
  private centreY = 0;
  private currentZoom: number = CameraTuning.restZoom;
  /** Always normalised to `(-π, π]`. */
  private currentRotation = 0;

  /** Peak shake displacement remaining, in world units. Zero when at rest. */
  private shakeAmplitude = 0;
  /**
   * Milliseconds since the shake started. The offset is a pure function of this,
   * which is what makes the shake frame-rate independent as well as seeded.
   */
  private shakeElapsedMs = 0;
  private shakeFastHz = 0;
  private shakeSlowHz = 0;
  private shakePhaseX0 = 0;
  private shakePhaseX1 = 0;
  private shakePhaseY0 = 0;
  private shakePhaseY1 = 0;

  /** xorshift32 state. Advances when a shake starts and never per frame. */
  private rngState: number;

  /**
   * False until the camera has been placed. The first `update` teleports rather
   * than sliding in from the origin, matching `FixedTimestepLoop.advance`'s
   * "the first call establishes the origin and does no work".
   */
  private placed = false;

  private rotationOn: boolean;
  private readonly storage: CameraStorage | null;
  private readonly reducedMotion: () => boolean;

  constructor(options: CameraOptions = {}) {
    this.rngState = normaliseSeed(options.seed ?? 0x5eed_ca11);
    this.storage = options.storage ?? probeStorage();
    this.reducedMotion = options.reducedMotion ?? probeReducedMotion();
    this.rotationOn = readRotation(this.storage, options.rotationDefault ?? false);
  }

  /** Whether rotation-to-heading is on. Reduced motion overrides it at the target, not here. */
  get rotationEnabled(): boolean {
    return this.rotationOn;
  }

  /**
   * Turn rotation-to-heading on or off, and remember the choice.
   *
   * Does not snap: the camera eases to the new target like any other change, so
   * flipping the toggle mid-drive is not itself a lurch.
   */
  setRotationEnabled(enabled: boolean): void {
    this.rotationOn = enabled;
    writeRotation(this.storage, enabled);
  }

  /** Advance the camera by `elapsedMs` of wall time toward `target`. */
  update(target: CameraTarget, elapsedMs: number): void {
    if (!this.placed) {
      this.snap(target);
      return;
    }

    // Some clocks run backwards. `loop.ts` guards its own accumulator but cannot
    // guard this one, and a negative delta makes `1 - exp(-dt/tau)` exceed 1 —
    // which overshoots the target and then oscillates around it forever.
    const dt = elapsedMs > 0 ? elapsedMs : 0;

    const desired = desiredCentre(target);
    const followBlend = blend(dt, CameraTuning.followTauMs);
    this.centreX += (desired.x - this.centreX) * followBlend;
    this.centreY += (desired.y - this.centreY) * followBlend;

    this.currentZoom +=
      (desiredZoom(target) - this.currentZoom) * blend(dt, CameraTuning.zoomTauMs);

    // Rotation eases along the *shortest* difference, not the raw one: going
    // from 3.1 rad to -3.1 rad the long way spins the whole world in place,
    // which is the single most sickening thing a camera can do.
    const rotationDelta = normaliseAngle(this.desiredRotation(target) - this.currentRotation);
    this.currentRotation = normaliseAngle(
      this.currentRotation + rotationDelta * blend(dt, CameraTuning.rotationTauMs),
    );

    if (this.shakeAmplitude > 0) {
      this.shakeElapsedMs += dt;
      if (this.currentShake() < CameraTuning.shakeMinAmplitude) this.shakeAmplitude = 0;
    }
  }

  /**
   * Place the camera on `target` immediately, with no easing and no shake.
   *
   * For the start of a run and for `G-01`'s respawn — a cab that reappears
   * across the city should not drag the view over everything in between.
   */
  snap(target: CameraTarget): void {
    const desired = desiredCentre(target);
    this.centreX = desired.x;
    this.centreY = desired.y;
    this.currentZoom = desiredZoom(target);
    this.currentRotation = this.desiredRotation(target);
    this.shakeAmplitude = 0;
    this.shakeElapsedMs = 0;
    this.placed = true;
  }

  /**
   * Start a shake of `intensity` world units peak displacement.
   *
   * Deliberately not `Math.random()`. The client is allowed unseeded randomness
   * where the sim is not, but a camera that shakes differently on every playback
   * of a replay makes `C-05`'s side-by-side capture compare noise. Frequencies
   * and phases are drawn once per impact from a seeded xorshift32; the per-frame
   * offset is then a pure function of elapsed shake time, so the same shake is
   * identical at 60 Hz and at 144 Hz as well as across runs.
   */
  shake(intensity: number = CameraTuning.crashShake): void {
    if (!(intensity > 0)) return;

    // A second hit while the first is still ringing must not *calm* the camera.
    const amplitude = Math.max(intensity, this.currentShake());

    const span = CameraTuning.shakeMaxHz - CameraTuning.shakeMinHz;
    this.shakeFastHz = CameraTuning.shakeMinHz + this.nextUnit() * span;
    this.shakeSlowHz = CameraTuning.shakeMinHz + this.nextUnit() * span;
    this.shakePhaseX0 = this.nextUnit() * TAU_RADIANS;
    this.shakePhaseX1 = this.nextUnit() * TAU_RADIANS;
    this.shakePhaseY0 = this.nextUnit() * TAU_RADIANS;
    this.shakePhaseY1 = this.nextUnit() * TAU_RADIANS;

    this.shakeAmplitude = amplitude;
    this.shakeElapsedMs = 0;
  }

  /** The view to draw from, this frame. */
  view(): CameraView {
    // Shake is gated here, at the output, rather than inside `shake()`. Flipping
    // the OS setting mid-crash then stops the shake *now* instead of letting the
    // one already in flight ring out, which is what someone reaching for that
    // setting during a crash is actually asking for. Rotation is gated at the
    // target instead (see `desiredRotation`) because there the opposite holds:
    // snapping the whole world to north-up is more motion than the rotation was.
    const amplitude = this.reducedMotion() ? 0 : this.currentShake();
    let shakeX = 0;
    let shakeY = 0;
    if (amplitude > 0) {
      const seconds = this.shakeElapsedMs / 1000;
      const fast = TAU_RADIANS * this.shakeFastHz * seconds;
      const slow = TAU_RADIANS * this.shakeSlowHz * seconds;
      // Two components per axis so it reads as a rattle rather than a wobble,
      // with a different phase pair per axis so the two do not trace a diagonal.
      // The weights sum to 1, which keeps `amplitude` a true peak bound.
      shakeX =
        amplitude *
        (0.62 * Math.sin(fast + this.shakePhaseX0) + 0.38 * Math.sin(slow + this.shakePhaseX1));
      shakeY =
        amplitude *
        (0.62 * Math.sin(fast + this.shakePhaseY0) + 0.38 * Math.sin(slow + this.shakePhaseY1));
    }

    return {
      x: this.centreX + shakeX,
      y: this.centreY + shakeY,
      shakeX,
      shakeY,
      zoom: this.currentZoom,
      rotation: this.currentRotation,
    };
  }

  /** Peak displacement left in the current shake, before the reduced-motion gate. */
  private currentShake(): number {
    if (this.shakeAmplitude <= 0) return 0;
    return this.shakeAmplitude * Math.exp(-this.shakeElapsedMs / CameraTuning.shakeDecayTauMs);
  }

  private desiredRotation(target: CameraTarget): number {
    if (!this.rotationOn || this.reducedMotion()) return 0;
    // The cab points along `heading` in world space and has to end up pointing
    // at the top of the screen. Under the transform documented on
    // {@link CameraView}, a world direction θ lands on screen at `θ - rotation`
    // measured from +x with y downward, and straight up is -π/2 — so
    // `rotation = heading + π/2`.
    return normaliseAngle(target.heading + Math.PI / 2);
  }

  /** One float in `[0, 1)`. Advances the shake RNG. */
  private nextUnit(): number {
    let x = this.rngState;
    x ^= x << 13;
    x |= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x |= 0;
    this.rngState = x;
    return (x >>> 0) / 4_294_967_296;
  }
}

// ---------------------------------------------------------------------------

/**
 * Fraction of the remaining distance to cover in `elapsedMs`.
 *
 * The whole reason this is a function of elapsed time and not a constant.
 * Exponential decay is the only smoothing that gives the same answer for the
 * same wall-clock duration however many frames it is split across.
 */
function blend(elapsedMs: number, tauMs: number): number {
  return 1 - Math.exp(-elapsedMs / tauMs);
}

/** Where the camera would sit if it were infinitely fast: the cab, plus its lead. */
function desiredCentre(target: CameraTarget): { x: number; y: number } {
  let leadX = target.velocityX * CameraTuning.lookaheadTicks;
  let leadY = target.velocityY * CameraTuning.lookaheadTicks;

  const distance = Math.hypot(leadX, leadY);
  if (distance > CameraTuning.maxLookahead) {
    const scale = CameraTuning.maxLookahead / distance;
    leadX *= scale;
    leadY *= scale;
  }

  return { x: target.x + leadX, y: target.y + leadY };
}

function desiredZoom(target: CameraTarget): number {
  const fraction = clamp01(target.speedFraction);
  return CameraTuning.restZoom + (CameraTuning.fastZoom - CameraTuning.restZoom) * fraction;
}

/** Clamps, and turns `NaN` into 0 rather than propagating it into the view. */
function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

/**
 * Fold an angle into `(-π, π]`.
 *
 * Applied to the stored rotation every update, not only to differences. A cab
 * doing donuts accumulates turns forever otherwise, and the stored value drifts
 * to 7.3 rad where it means 1.0 — harmless to draw with, and a nuisance to
 * everything else that reads it.
 */
function normaliseAngle(angle: number): number {
  const wrapped = angle % TAU_RADIANS;
  if (wrapped > Math.PI) return wrapped - TAU_RADIANS;
  if (wrapped <= -Math.PI) return wrapped + TAU_RADIANS;
  return wrapped;
}

function normaliseSeed(seed: number): number {
  // xorshift32 has exactly one dead state, and it is the one a caller is most
  // likely to pass by accident.
  const state = seed | 0;
  return state === 0 ? 0x9e37_79b9 | 0 : state;
}

/**
 * Find `localStorage`, or decide there isn't one.
 *
 * Reading the *property* can throw, not just calling a method on it: a browser
 * with cookies blocked raises `SecurityError` on `globalThis.localStorage`
 * itself, and a Worker has no such property at all. Both mean the same thing
 * here — the toggle works for this session and is forgotten afterwards, which
 * is a great deal better than the camera refusing to construct.
 */
function probeStorage(): CameraStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: CameraStorage }).localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

/**
 * A live read of `prefers-reduced-motion`.
 *
 * The `MediaQueryList` is fetched once and its `.matches` read on demand, so a
 * change to the OS setting takes effect on the next frame with no listener to
 * register or tear down.
 */
function probeReducedMotion(): () => boolean {
  try {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (query === undefined || query === null) return () => false;
    return () => query.matches;
  } catch {
    return () => false;
  }
}

function readRotation(storage: CameraStorage | null, fallback: boolean): boolean {
  if (storage === null) return fallback;
  try {
    const stored = storage.getItem(ROTATION_STORAGE_KEY);
    if (stored === 'on') return true;
    if (stored === 'off') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeRotation(storage: CameraStorage | null, enabled: boolean): void {
  if (storage === null) return;
  try {
    storage.setItem(ROTATION_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Private mode, or a full quota. The toggle still works for this session,
    // and throwing out of a settings change because a preference could not be
    // written would be the worse outcome.
  }
}
