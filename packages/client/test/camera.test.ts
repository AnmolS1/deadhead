import { describe, expect, it } from 'vitest';

import {
  Car,
  FX_ONE,
  TURN,
  createWorld,
  emptyCity,
  fxFromInt,
  hashWorld,
  setCar,
  step,
  type World,
} from '@deadhead/sim';

import {
  Camera,
  CameraTuning,
  ROTATION_STORAGE_KEY,
  cameraTargetFromCar,
  interpolatedEye,
  type CameraStorage,
  type CameraTarget,
} from '../src/camera.js';

/**
 * The camera is float, render-only, and driven by wall-clock milliseconds — so
 * every test here is arithmetic over synthetic frame timings. No jsdom: the
 * three browser things it touches (`localStorage`, `matchMedia`,
 * `devicePixelRatio`-adjacent nothing) are injected as plain objects, the same
 * way `canvas.test.ts` stubs a canvas rather than pulling in a DOM.
 */

const AT_REST: CameraTarget = {
  x: 0,
  y: 0,
  velocityX: 0,
  velocityY: 0,
  heading: 0,
  speedFraction: 0,
};

function target(overrides: Partial<CameraTarget>): CameraTarget {
  return { ...AT_REST, ...overrides };
}

/** A camera with nothing ambient about it: no storage, motion allowed, fixed seed. */
function camera(options: { seed?: number; reducedMotion?: () => boolean } = {}): Camera {
  return new Camera({
    storage: fakeStorage(),
    reducedMotion: options.reducedMotion ?? (() => false),
    seed: options.seed ?? 1,
  });
}

function fakeStorage(initial: Record<string, string> = {}): CameraStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/**
 * Drive a camera with a synthetic display of a given refresh rate for a fixed
 * wall-clock duration. `at` may vary the target with time, which is how the
 * moving-target cases below are built.
 *
 * The frame length is derived from the duration rather than from the refresh
 * rate, so **every rate delivers exactly `seconds` of wall time** — 144 Hz does
 * not divide 0.2 s into a whole number of 6.944 ms frames, and a harness that
 * ran `round(hz × seconds)` frames of `1000 / hz` would hand the two cameras
 * different amounts of time and then blame the camera for the difference. (It
 * did. That is what this comment is for.)
 */
function runDisplay(
  subject: Camera,
  hz: number,
  seconds: number,
  at: CameraTarget | ((elapsedMs: number) => CameraTarget),
): void {
  const frames = Math.max(1, Math.round(hz * seconds));
  const frameMs = (seconds * 1000) / frames;
  const poseAt = typeof at === 'function' ? at : () => at;

  for (let frame = 0; frame < frames; frame += 1) {
    subject.update(poseAt(frame * frameMs), frameMs);
  }
}

// ---------------------------------------------------------------------------

describe('following the cab', () => {
  it('places the camera on the first update instead of sliding in from the origin', () => {
    // Without this the view sweeps across the whole city on the first frame of
    // every run. Mirrors FixedTimestepLoop.advance's "the first call
    // establishes the origin".
    const subject = camera();
    subject.update(target({ x: 400, y: -250 }), 1000 / 60);

    const view = subject.view();
    expect(view.x).toBeCloseTo(400, 9);
    expect(view.y).toBeCloseTo(-250, 9);
  });

  it('leads the cab in the direction of travel', () => {
    // The point of the lookahead: at speed the player must be able to read the
    // junction they are arriving at, not the one they just left.
    const subject = camera();
    const moving = target({ x: 0, y: 0, velocityX: 1, velocityY: 0, speedFraction: 1 });
    subject.snap(target({}));
    runDisplay(subject, 60, 2, moving);

    expect(subject.view().x).toBeGreaterThan(moving.x + 1);
  });

  it('trails the cab when it reverses', () => {
    // The same property with the sign flipped. A lead implemented as
    // `x + speed * k` rather than from the velocity vector passes the test
    // above and fails this one.
    const subject = camera();
    const reversing = target({ velocityX: -0.3, speedFraction: 0.3 });
    subject.snap(target({}));
    runDisplay(subject, 60, 2, reversing);

    expect(subject.view().x).toBeLessThan(-1);
  });

  it('caps the lead however fast the cab is going', () => {
    // A launch, a bad prediction correction, or a `C-05` interpolation over a
    // teleport can all produce a velocity far past anything the car model
    // allows. Uncapped, the cab leaves the screen entirely.
    const subject = camera();
    const absurd = target({ velocityX: 50, velocityY: 50 });
    subject.snap(absurd);

    const view = subject.view();
    expect(Math.hypot(view.x, view.y)).toBeLessThanOrEqual(CameraTuning.maxLookahead + 1e-9);
  });

  it('settles on a stationary cab', () => {
    const subject = camera();
    subject.snap(target({ x: -100 }));
    runDisplay(subject, 60, 3, target({ x: 42, y: 17 }));

    expect(subject.view().x).toBeCloseTo(42, 3);
    expect(subject.view().y).toBeCloseTo(17, 3);
  });

  it('does not lurch when the clock runs backwards', () => {
    // Some clocks do. A negative delta makes `1 - exp(-dt/tau)` exceed 1, which
    // overshoots the target and then oscillates around it forever.
    const subject = camera();
    subject.snap(target({}));
    subject.update(target({ x: 100 }), -50);

    expect(subject.view().x).toBe(0);
  });
});

describe('frame-rate independence', () => {
  it('lands in the same place at 60 Hz and at 144 Hz', () => {
    // The failure this whole design exists to prevent. A fixed per-frame lerp
    // covers 2.4x more ground at 144 Hz than at 60 Hz over the same wall-clock
    // second, so the game would literally play differently on a better monitor
    // and C-05's side-by-side capture would be measuring the monitor.
    //
    // With a stationary target the exponential form is exact — the product of
    // the per-frame `(1 - a)` factors is `exp(-total / tau)` however the second
    // is chopped up — so this can be asserted to float precision.
    const destination = target({ x: 500, y: -300, speedFraction: 0.6, heading: 1.1 });

    const slow = camera();
    const fast = camera();
    slow.setRotationEnabled(true);
    fast.setRotationEnabled(true);
    slow.snap(target({}));
    fast.snap(target({}));

    runDisplay(slow, 60, 0.5, destination);
    runDisplay(fast, 144, 0.5, destination);

    // Every smoothed channel, not just position: getting x/y right and then
    // writing `zoom += diff * 0.1` for the others is the easy version of this bug.
    expect(fast.view().x).toBeCloseTo(slow.view().x, 9);
    expect(fast.view().y).toBeCloseTo(slow.view().y, 9);
    expect(fast.view().zoom).toBeCloseTo(slow.view().zoom, 9);
    expect(fast.view().rotation).toBeCloseTo(slow.view().rotation, 9);
  });

  it('tracks a moving cab to within a fraction of a percent at either rate', () => {
    // A moving target is *not* identical between refresh rates and cannot be:
    // each frame holds the target constant for its own duration, which leaves a
    // steady-state lag of about `v × (tau - dt/2)`, so 60 Hz trails 144 Hz by
    // roughly 5 ms of travel. Over the 300 units covered here that is ~1.5
    // units. The bug being caught differs by 2.4x — tens of units — so 1% of
    // the distance travelled separates them by two orders of magnitude.
    const speed = 1; // units/tick, i.e. cab flat out
    const travelled = 300;
    const moving = (elapsedMs: number): CameraTarget =>
      target({ x: (elapsedMs / 1000) * speed * 30, velocityX: speed, speedFraction: 1 });

    const slow = camera();
    const fast = camera();
    slow.snap(moving(0));
    fast.snap(moving(0));
    runDisplay(slow, 60, 10, moving);
    runDisplay(fast, 144, 10, moving);

    expect(Math.abs(fast.view().x - slow.view().x)).toBeLessThan(travelled * 0.01);
  });

  it('smooths a 30 Hz target into 144 Hz motion', () => {
    // The other half of C-03's done-when, and the reason CameraTarget exists as
    // a float struct at all. The sim produces a new pose thirty times a second;
    // a camera pinned straight to it moves a whole unit on one frame in five
    // and not at all on the other four, which is exactly the stutter this task
    // is about. Smoothed, the same motion arrives as ~0.21 units every frame.
    const subject = camera();
    const frameMs = 1000 / 144;
    const staircase = (elapsedMs: number): CameraTarget =>
      target({ x: Math.floor((elapsedMs / 1000) * 30), speedFraction: 1 });

    subject.snap(staircase(0));

    let previous = subject.view().x;
    let smallest = Infinity;
    let largest = 0;
    for (let frame = 1; frame <= 300; frame += 1) {
      subject.update(staircase(frame * frameMs), frameMs);
      const x = subject.view().x;
      // Skip the first 60 frames: the follow is still settling into its
      // steady-state lag and its deltas are transient, not the property here.
      if (frame > 60) {
        smallest = Math.min(smallest, x - previous);
        largest = Math.max(largest, x - previous);
      }
      previous = x;
    }

    expect(largest).toBeLessThan(0.4);
    // The one that actually bites. A camera pinned to the target sits perfectly
    // still on four frames out of five, and `largest` alone would not say so.
    expect(smallest).toBeGreaterThan(0.05);
  });

  it('shakes identically at 60 Hz and at 144 Hz', () => {
    // The reason the shake is a function of elapsed shake time rather than a
    // per-frame random walk: a walk would draw 2.4x as many samples at 144 Hz
    // and produce a different shake, which is the same class of bug as the lerp
    // above wearing a different hat.
    const slow = camera();
    const fast = camera();
    slow.snap(target({}));
    fast.snap(target({}));
    slow.shake(2);
    fast.shake(2);

    runDisplay(slow, 60, 0.2, AT_REST);
    runDisplay(fast, 144, 0.2, AT_REST);

    expect(fast.view().shakeX).toBeCloseTo(slow.view().shakeX, 9);
    expect(fast.view().shakeY).toBeCloseTo(slow.view().shakeY, 9);
  });
});

describe('speed-based zoom', () => {
  it('shows more road at speed than at rest', () => {
    const parked = camera();
    const flying = camera();
    parked.snap(target({ speedFraction: 0 }));
    flying.snap(target({ speedFraction: 1 }));

    // Lower zoom is a wider view — the renderer multiplies its pixels-per-unit
    // by this, so less scale means more world on screen.
    expect(flying.view().zoom).toBeLessThan(parked.view().zoom);
  });

  it('comes back in when the cab stops', () => {
    const subject = camera();
    subject.snap(target({ speedFraction: 1 }));
    runDisplay(subject, 60, 5, target({ speedFraction: 0 }));

    expect(subject.view().zoom).toBeCloseTo(CameraTuning.restZoom, 3);
  });

  it('is monotonic in speed', () => {
    // Rather than asserting the endpoints equal two constants, which would only
    // restate the tuning table.
    let previous = Infinity;
    for (let fraction = 0; fraction <= 1; fraction += 0.1) {
      const subject = camera();
      subject.snap(target({ speedFraction: fraction }));
      const zoom = subject.view().zoom;
      expect(zoom).toBeLessThanOrEqual(previous);
      previous = zoom;
    }
  });

  it('survives a speed fraction outside [0, 1]', () => {
    // `C-05` interpolates between sim states and can overshoot slightly, and a
    // clamped-then-lerped zoom is the difference between a wide view and an
    // inverted one.
    const over = camera();
    over.snap(target({ speedFraction: 4 }));
    expect(over.view().zoom).toBeCloseTo(CameraTuning.fastZoom, 9);

    const under = camera();
    under.snap(target({ speedFraction: -2 }));
    expect(under.view().zoom).toBeCloseTo(CameraTuning.restZoom, 9);
  });
});

describe('rotation-to-heading', () => {
  it('is off unless asked for', () => {
    // A rotating camera makes a meaningful number of people motion-sick. The
    // setting that does that is the one you opt into, not the one you discover
    // you need to turn off (G-09).
    const subject = new Camera({ storage: fakeStorage(), reducedMotion: () => false });
    expect(subject.rotationEnabled).toBe(false);

    subject.snap(target({ heading: 1.2 }));
    expect(subject.view().rotation).toBe(0);
  });

  it('turns the cab to the top of the screen when on', () => {
    // Under the transform documented on CameraView, a world direction θ lands
    // on screen at `θ - rotation`, and straight up is -π/2 — so a camera that
    // points the cab upward settles at `heading + π/2`. Asserting the
    // relationship rather than a magic number is the point: this is the number
    // C-04 will get the sign of wrong.
    const subject = camera();
    subject.setRotationEnabled(true);
    const heading = 0.7;
    subject.snap(target({ heading }));

    expect(subject.view().rotation).toBeCloseTo(heading + Math.PI / 2, 9);
  });

  it('takes the short way round the wrap', () => {
    // Easing from +3.1 rad to -3.1 rad the long way spins the entire world in
    // place. The total angular distance travelled is the giveaway: about 0.08
    // rad the short way, about 6.2 the long way.
    const subject = camera();
    subject.setRotationEnabled(true);

    const before = 3.1 - Math.PI / 2;
    const after = -3.1 - Math.PI / 2;
    subject.snap(target({ heading: before }));

    let travelled = 0;
    let previous = subject.view().rotation;
    for (let frame = 0; frame < 300; frame += 1) {
      subject.update(target({ heading: after }), 1000 / 60);
      const current = subject.view().rotation;
      let delta = current - previous;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      travelled += Math.abs(delta);
      previous = current;
    }

    expect(travelled).toBeLessThan(0.5);
    expect(subject.view().rotation).toBeCloseTo(-3.1, 3);
  });

  it('stays normalised while the cab does donuts', () => {
    // The stored angle accumulates forever if only the difference is wrapped,
    // and drifts to 7.3 rad where it means 1.0. Harmless to draw with; a
    // nuisance to every other reader (C-06's overlay, G-09's checks).
    const subject = camera();
    subject.setRotationEnabled(true);
    subject.snap(target({ heading: 0 }));

    for (let frame = 0; frame < 2_000; frame += 1) {
      subject.update(target({ heading: frame * 0.4 }), 1000 / 60);
      const { rotation } = subject.view();
      expect(rotation).toBeGreaterThan(-Math.PI - 1e-9);
      expect(rotation).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('eases back to north-up when switched off rather than snapping', () => {
    // Toggling the setting mid-drive should not itself be a lurch.
    const subject = camera();
    subject.setRotationEnabled(true);
    subject.snap(target({ heading: 0 }));
    const settled = subject.view().rotation;
    expect(Math.abs(settled)).toBeGreaterThan(1);

    subject.setRotationEnabled(false);
    subject.update(target({ heading: 0 }), 1000 / 60);
    const oneFrameLater = subject.view().rotation;

    expect(Math.abs(oneFrameLater)).toBeLessThan(Math.abs(settled));
    expect(Math.abs(oneFrameLater)).toBeGreaterThan(0);
  });
});

describe('the rotation toggle persists', () => {
  it('writes the choice and reads it back into a fresh camera', () => {
    const storage = fakeStorage();
    const first = new Camera({ storage, reducedMotion: () => false });
    first.setRotationEnabled(true);

    expect(new Camera({ storage, reducedMotion: () => false }).rotationEnabled).toBe(true);
  });

  it('remembers being switched off, rather than falling back to the default', () => {
    // The bug an "only store the non-default value" scheme produces: turning
    // rotation off works until the page reloads, and only for people who had
    // turned it on. Distinguishing "off" from "never set" is the whole job.
    const storage = fakeStorage();
    const first = new Camera({ storage, rotationDefault: true, reducedMotion: () => false });
    first.setRotationEnabled(false);

    const second = new Camera({ storage, rotationDefault: true, reducedMotion: () => false });
    expect(second.rotationEnabled).toBe(false);
  });

  it('ignores a stored value it does not understand', () => {
    const storage = fakeStorage({ [ROTATION_STORAGE_KEY]: 'yes please' });
    expect(new Camera({ storage, reducedMotion: () => false }).rotationEnabled).toBe(false);
  });

  it('constructs when storage throws on read', () => {
    // Private mode, or a browser with cookies blocked. Refusing to construct a
    // camera because a preference could not be read would take the whole game
    // down over a setting.
    const hostile: CameraStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };

    const subject = new Camera({ storage: hostile, rotationDefault: true });
    expect(subject.rotationEnabled).toBe(true);
    expect(() => subject.setRotationEnabled(false)).not.toThrow();
    expect(subject.rotationEnabled).toBe(false);
  });

  it('works with no storage at all', () => {
    // The camera is constructed in tests and could be constructed in a Worker;
    // neither has a localStorage. It probes for one and shrugs.
    const subject = new Camera({ reducedMotion: () => false });
    expect(() => subject.setRotationEnabled(true)).not.toThrow();
    expect(subject.rotationEnabled).toBe(true);
  });
});

describe('screenshake', () => {
  it('is exactly zero before anything has hit', () => {
    // A camera that jitters while parked is a bug that ships, because it looks
    // like a rendering artefact rather than like the camera.
    const subject = camera();
    runDisplay(subject, 144, 2, AT_REST);

    expect(subject.view().shakeX).toBe(0);
    expect(subject.view().shakeY).toBe(0);
  });

  it('moves the view and then stops', () => {
    const subject = camera();
    subject.snap(target({}));
    subject.shake(CameraTuning.crashShake);
    subject.update(AT_REST, 20);

    const during = subject.view();
    expect(Math.hypot(during.shakeX, during.shakeY)).toBeGreaterThan(0);
    expect(during.x).toBe(during.shakeX);

    runDisplay(subject, 60, 3, AT_REST);
    const after = subject.view();
    expect(after.shakeX).toBe(0);
    expect(after.shakeY).toBe(0);
    expect(after.x).toBe(0);
  });

  it('never displaces further than the intensity asked for', () => {
    // The two sinusoid weights sum to 1 precisely so `intensity` is a real
    // bound, which is what lets C-08 tune a crash against the cab's size.
    const subject = camera();
    subject.snap(target({}));
    subject.shake(1.25);

    for (let frame = 0; frame < 400; frame += 1) {
      subject.update(AT_REST, 1000 / 144);
      const view = subject.view();
      expect(Math.abs(view.shakeX)).toBeLessThanOrEqual(1.25 + 1e-9);
      expect(Math.abs(view.shakeY)).toBeLessThanOrEqual(1.25 + 1e-9);
    }
  });

  it('is reproducible from its seed', () => {
    // Math.random() here would make C-05's A/B capture compare noise, and would
    // make "did that change feel better" unanswerable. Same seed, same frame
    // timings, same shake — byte for byte.
    const first = camera({ seed: 0xc0ffee });
    const second = camera({ seed: 0xc0ffee });
    for (const subject of [first, second]) {
      subject.snap(target({}));
      subject.shake(1.5);
      runDisplay(subject, 60, 0.25, AT_REST);
    }

    expect(second.view().shakeX).toBe(first.view().shakeX);
    expect(second.view().shakeY).toBe(first.view().shakeY);
  });

  it('gives different seeds different shakes', () => {
    // Otherwise the seed is decoration and every crash in a run feels identical.
    const a = camera({ seed: 1 });
    const b = camera({ seed: 999 });
    for (const subject of [a, b]) {
      subject.snap(target({}));
      subject.shake(1.5);
      runDisplay(subject, 60, 0.1, AT_REST);
    }

    expect(b.view().shakeX).not.toBe(a.view().shakeX);
  });

  it('gives successive crashes in one run different shakes', () => {
    // A single set of frequencies drawn at construction would make every impact
    // in a run identical, which reads as a canned animation.
    const subject = camera();
    subject.snap(target({}));

    subject.shake(1);
    runDisplay(subject, 60, 0.05, AT_REST);
    const firstImpact = subject.view().shakeX;

    runDisplay(subject, 60, 2, AT_REST);
    subject.shake(1);
    runDisplay(subject, 60, 0.05, AT_REST);

    expect(subject.view().shakeX).not.toBe(firstImpact);
  });

  it('is not calmed by a second, smaller hit', () => {
    // Clipping a wall a few frames after a crash must not settle the camera
    // down. Asserted on the *peak* over a window rather than on one sample:
    // each `shake()` redraws the phases, so a single reading is whatever the
    // draw happened to give and cannot tell a budget of 1.7 from one of 0.05.
    const subject = camera();
    subject.snap(target({}));
    subject.shake(2);
    runDisplay(subject, 144, 0.03, AT_REST);

    subject.shake(0.05);
    let peak = 0;
    for (let frame = 0; frame < 9; frame += 1) {
      subject.update(AT_REST, 1000 / 144);
      peak = Math.max(peak, Math.abs(subject.view().shakeX));
    }

    // The scrape's own 0.05 could not reach a tenth of this.
    expect(peak).toBeGreaterThan(0.5);
  });

  it('ignores a nonsensical intensity', () => {
    const subject = camera();
    subject.snap(target({}));
    subject.shake(0);
    subject.shake(-3);
    subject.update(AT_REST, 16);

    expect(subject.view().shakeX).toBe(0);
  });

  it('is cleared by a snap', () => {
    // G-01 respawns the cab across the city; the crash that put it there must
    // not follow it.
    const subject = camera();
    subject.snap(target({}));
    subject.shake(2);
    subject.snap(target({ x: 900 }));

    expect(subject.view().shakeX).toBe(0);
    expect(subject.view().x).toBe(900);
  });
});

describe('prefers-reduced-motion', () => {
  it('disables shake and rotation together', () => {
    // G-09's done-when: the game is completable with reduced motion on.
    let reduced = true;
    const subject = new Camera({
      storage: fakeStorage(),
      reducedMotion: () => reduced,
      seed: 7,
    });
    subject.setRotationEnabled(true);
    subject.snap(target({ heading: 1.2 }));
    subject.shake(2);
    subject.update(target({ heading: 1.2 }), 16);

    const view = subject.view();
    expect(view.rotation).toBe(0);
    expect(view.shakeX).toBe(0);
    expect(view.shakeY).toBe(0);

    // ...and the setting is honoured live, not only at load.
    reduced = false;
    subject.update(target({ heading: 1.2 }), 16);
    expect(subject.view().rotation).not.toBe(0);
  });

  it('stops a shake already in flight the instant the setting is turned on', () => {
    // Gating at the output rather than inside `shake()`. Someone reaching for
    // that setting during a crash wants the shake to stop now, not to ring out.
    let reduced = false;
    const subject = new Camera({
      storage: fakeStorage(),
      reducedMotion: () => reduced,
      seed: 7,
    });
    subject.snap(target({}));
    subject.shake(2);
    subject.update(AT_REST, 16);
    expect(subject.view().shakeX).not.toBe(0);

    reduced = true;
    expect(subject.view().shakeX).toBe(0);
    expect(subject.view().shakeY).toBe(0);
  });

  it('eases rotation level instead of snapping it', () => {
    // Gating rotation at the *target* rather than the output. A whole-world snap
    // to north-up is more motion than the rotation the user was objecting to.
    let reduced = false;
    const subject = new Camera({ storage: fakeStorage(), reducedMotion: () => reduced });
    subject.setRotationEnabled(true);
    subject.snap(target({ heading: 0 }));
    const settled = subject.view().rotation;

    reduced = true;
    subject.update(target({ heading: 0 }), 1000 / 60);
    const next = subject.view().rotation;

    expect(Math.abs(next)).toBeLessThan(Math.abs(settled));
    expect(next).not.toBe(0);
  });

  it('keeps rotation off while the toggle is on but motion is reduced', () => {
    // The user's stored preference is not overwritten — it is overridden. Turn
    // reduced motion back off and their rotation comes back.
    const storage = fakeStorage();
    const subject = new Camera({ storage, reducedMotion: () => true });
    subject.setRotationEnabled(true);
    expect(subject.rotationEnabled).toBe(true);

    subject.snap(target({ heading: 1 }));
    expect(subject.view().rotation).toBe(0);
    expect(new Camera({ storage, reducedMotion: () => false }).rotationEnabled).toBe(true);
  });
});

describe('the sim never sees the camera', () => {
  function drivingWorld(): World {
    const world = createWorld(7, 1, emptyCity());
    setCar(world, 0, Car.VelocityX, FX_ONE / 2);
    setCar(world, 0, Car.Heading, TURN / 8);
    return world;
  }

  it('leaves the world hash untouched over a run', () => {
    // Hard constraint: delete the camera and replays produce identical hashes.
    // This is that sentence, executable. If the camera ever writes through a
    // getter — or if `cameraTargetFromCar` ever grows a `setCar` — this is what
    // fails, and it fails before anyone notices the leaderboard is wrong.
    let control = drivingWorld();
    let observed = drivingWorld();
    const subject = camera();
    const inputs = [0];

    for (let tick = 0; tick < 200; tick += 1) {
      control = step(control, inputs);
      observed = step(observed, inputs);
      // Interleaved exactly where the real client would call it.
      subject.update(cameraTargetFromCar(observed, 0), 1000 / 144);
      subject.view();
    }

    expect(hashWorld(observed)).toBe(hashWorld(control));
  });

  it('reads a pose out of the world without touching it', () => {
    const world = drivingWorld();
    const before = hashWorld(world);
    const pose = cameraTargetFromCar(world, 0);

    expect(hashWorld(world)).toBe(before);
    // Fixed point in, floats out: a half-unit-per-tick velocity is 0.5 here,
    // not 32768.
    expect(pose.velocityX).toBeCloseTo(0.5, 9);
    // An eighth of a uint16 turn is a right angle and a bit — 45 degrees.
    expect(pose.heading).toBeCloseTo(Math.PI / 4, 9);
    expect(pose.speedFraction).toBeGreaterThan(0);
    expect(pose.speedFraction).toBeLessThanOrEqual(1);
  });
});

describe('interpolatedEye — the camera follows the drawn cab, not the ticked one', () => {
  function worldWithCarAt(x: number, y: number): World {
    const w = createWorld(1, 1, emptyCity());
    setCar(w, 0, Car.X, fxFromInt(x));
    setCar(w, 0, Car.Y, fxFromInt(y));
    return w;
  }

  it('lands halfway between two ticks at alpha 0.5', () => {
    // THE regression test. `scene.ts` draws the cab through `poseOf(previous,
    // current, alpha)` at display rate; the camera used to read `current` raw,
    // which steps at TICK_HZ. The cab was therefore drawn smoothly inside a
    // viewport that jumped 30 times a second and juddered against the centre of
    // the screen by up to one tick of travel — a whole world unit at top speed.
    const eye = interpolatedEye(worldWithCarAt(10, 20), worldWithCarAt(12, 20), 0, 0.5);
    expect(eye.x).toBeCloseTo(11, 5);
    expect(eye.y).toBeCloseTo(20, 5);
  });

  it('is continuous across the whole alpha range', () => {
    const previous = worldWithCarAt(0, 0);
    const current = worldWithCarAt(1, 0);
    let last = -Infinity;
    for (let a = 0; a < 1; a += 0.1) {
      const { x } = interpolatedEye(previous, current, 0, a);
      expect(x).toBeGreaterThanOrEqual(last);
      last = x;
    }
    expect(interpolatedEye(previous, current, 0, 0).x).toBeCloseTo(0, 5);
  });

  it('snaps rather than sliding across the city on a teleport', () => {
    // A respawn (`G-01`) moves the cab a long way in one tick. Interpolating
    // that would sweep the camera over the whole map in a single frame, which
    // is far more jarring than the snap it replaces.
    const eye = interpolatedEye(worldWithCarAt(0, 0), worldWithCarAt(400, 400), 0, 0.5);
    expect(eye.x).toBeCloseTo(400, 5);
    expect(eye.y).toBeCloseTo(400, 5);
  });
});
