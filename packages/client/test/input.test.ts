import { describe, expect, it } from 'vitest';

import { INPUT_MASK, Input, hasInput } from '@deadhead/proto';

import {
  DEFAULT_BINDINGS,
  InputBuffer,
  attachKeyboard,
  attachTouch,
  loadBindings,
  pollGamepad,
  saveBindings,
  touchZones,
  type Bindings,
} from '../src/input/index.js';
import { zoneAt } from '../src/input/touch.js';

/** A minimal event target, so keyboard handling can be tested without a browser. */
function fakeTarget() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    addEventListener(type: string, handler: (event: unknown) => void): void {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener(type: string, handler: (event: unknown) => void): void {
      listeners.get(type)?.delete(handler);
    },
    emit(type: string, event: Record<string, unknown> = {}): void {
      for (const handler of listeners.get(type) ?? []) {
        handler({ preventDefault: () => {}, ...event });
      }
    },
    count(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

/** A localStorage stand-in that can be told to misbehave. */
function fakeStorage(mode: 'ok' | 'throws' = 'ok') {
  const map = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      if (mode === 'throws') throw new Error('storage disabled');
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (mode === 'throws') throw new Error('quota exceeded');
      map.set(key, value);
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

// ---------------------------------------------------------------------------

describe('the buffer latches', () => {
  it('registers a press that began and ended between two ticks', () => {
    // C-02's done-when, and the reason this class exists. Reading the current
    // key state once per tick loses this tap entirely: the player pressed
    // handbrake, the game did not notice, and no log will ever show why.
    const buffer = new InputBuffer();

    buffer.press(Input.Handbrake);
    buffer.release(Input.Handbrake);

    expect(hasInput(buffer.sample(), Input.Handbrake)).toBe(true);
  });

  it('does not repeat that press on the following tick', () => {
    // Latched, not sticky. A 10 ms tap should last one tick, not forever.
    const buffer = new InputBuffer();
    buffer.press(Input.Handbrake);
    buffer.release(Input.Handbrake);

    buffer.sample();
    expect(hasInput(buffer.sample(), Input.Handbrake)).toBe(false);
  });

  it('keeps reporting a key that is still held', () => {
    const buffer = new InputBuffer();
    buffer.press(Input.Throttle);

    for (let tick = 0; tick < 10; tick += 1) {
      expect(hasInput(buffer.sample(), Input.Throttle), `tick ${tick}`).toBe(true);
    }

    buffer.release(Input.Throttle);
    expect(hasInput(buffer.sample(), Input.Throttle)).toBe(false);
  });

  it('survives a burst of taps faster than the tick rate', () => {
    // Four taps inside one tick collapse to one tick of input. That is the
    // documented trade: an input rounded up to 33 ms is imperceptible, a
    // dropped one is a bug the player feels and cannot explain.
    const buffer = new InputBuffer();
    for (let i = 0; i < 4; i += 1) {
      buffer.press(Input.Hail);
      buffer.release(Input.Hail);
    }
    expect(hasInput(buffer.sample(), Input.Hail)).toBe(true);
    expect(hasInput(buffer.sample(), Input.Hail)).toBe(false);
  });

  it('combines everything that happened in the tick', () => {
    const buffer = new InputBuffer();
    buffer.press(Input.Throttle);
    buffer.press(Input.Right);
    buffer.press(Input.Handbrake);
    buffer.release(Input.Handbrake);

    const byte = buffer.sample();
    expect(hasInput(byte, Input.Throttle)).toBe(true);
    expect(hasInput(byte, Input.Right)).toBe(true);
    expect(hasInput(byte, Input.Handbrake)).toBe(true);
    expect(hasInput(byte, Input.Brake)).toBe(false);
  });

  it('never emits a bit the sim does not define', () => {
    const buffer = new InputBuffer();
    buffer.press(0xff);
    expect(buffer.sample() & ~INPUT_MASK).toBe(0);
  });

  it('releaseAll clears held keys but not the tick in flight', () => {
    // Blur arrives; the keyup never will. But the press that already happened
    // this tick still happened.
    const buffer = new InputBuffer();
    buffer.press(Input.Throttle);
    buffer.releaseAll();

    expect(hasInput(buffer.sample(), Input.Throttle)).toBe(true);
    expect(hasInput(buffer.sample(), Input.Throttle)).toBe(false);
  });

  it('peek does not consume the latch', () => {
    const buffer = new InputBuffer();
    buffer.press(Input.Brake);
    buffer.release(Input.Brake);

    expect(hasInput(buffer.peek(), Input.Brake)).toBe(true);
    expect(hasInput(buffer.peek(), Input.Brake)).toBe(true);
    expect(hasInput(buffer.sample(), Input.Brake)).toBe(true);
  });
});

describe('every device produces the same byte', () => {
  it('keyboard, gamepad and touch agree on "throttle and right"', () => {
    // C-02's done-when. True by construction here rather than because three
    // implementations happen to agree — which is also what makes a recorded log
    // portable between devices.
    const keyboard = new InputBuffer();
    const target = fakeTarget();
    attachKeyboard(target as unknown as Window, keyboard, DEFAULT_BINDINGS);
    target.emit('keydown', { code: 'KeyW' });
    target.emit('keydown', { code: 'KeyD' });

    const gamepad = new InputBuffer();
    pollGamepad(
      {
        buttons: Array.from({ length: 16 }, (_, i) => ({
          pressed: i === 7,
          value: i === 7 ? 1 : 0,
        })),
        axes: [1, 0],
      } as unknown as Gamepad,
      gamepad,
    );

    const touch = new InputBuffer();
    const element = fakeTarget();
    attachTouch(element as unknown as HTMLElement, touch, () => ({ width: 100, height: 100 }));
    element.emit('touchstart', {
      touches: [
        { clientX: 90, clientY: 90 },
        { clientX: 30, clientY: 90 },
      ],
    });

    const expected = Input.Throttle | Input.Right;
    expect(keyboard.sample()).toBe(expected);
    expect(gamepad.sample()).toBe(expected);
    expect(touch.sample()).toBe(expected);
  });
});

describe('keyboard', () => {
  it('maps by physical position, not by letter', () => {
    // Bindings key off KeyboardEvent.code, so a default of `KeyW` is the same
    // physical key on QWERTY, AZERTY and Dvorak — the key under the player's
    // finger rather than the letter W.
    const buffer = new InputBuffer();
    const target = fakeTarget();
    attachKeyboard(target as unknown as Window, buffer, DEFAULT_BINDINGS);

    target.emit('keydown', { code: 'KeyW', key: 'z' });
    expect(hasInput(buffer.sample(), Input.Throttle)).toBe(true);
  });

  it('ignores keys it does not bind', () => {
    const buffer = new InputBuffer();
    const target = fakeTarget();
    attachKeyboard(target as unknown as Window, buffer, DEFAULT_BINDINGS);

    target.emit('keydown', { code: 'F5' });
    expect(buffer.sample()).toBe(0);
  });

  it('releases everything on blur', () => {
    // A key held while the tab loses focus never delivers its keyup. Without
    // this the cab drives into a wall while the player reads their email.
    const buffer = new InputBuffer();
    const target = fakeTarget();
    attachKeyboard(target as unknown as Window, buffer, DEFAULT_BINDINGS);

    target.emit('keydown', { code: 'KeyW' });
    buffer.sample();
    target.emit('blur');

    expect(buffer.sample()).toBe(0);
  });

  it('clears held keys when the bindings change', () => {
    // Otherwise anything held under the old map stays held forever, because the
    // keyup will look up a binding that no longer exists.
    const buffer = new InputBuffer();
    const target = fakeTarget();
    const handle = attachKeyboard(target as unknown as Window, buffer, DEFAULT_BINDINGS);

    target.emit('keydown', { code: 'KeyW' });
    buffer.sample();
    handle.setBindings({ KeyI: Input.Throttle });

    expect(buffer.sample()).toBe(0);
    target.emit('keydown', { code: 'KeyI' });
    expect(hasInput(buffer.sample(), Input.Throttle)).toBe(true);
  });

  it('removes every listener on detach', () => {
    const buffer = new InputBuffer();
    const target = fakeTarget();
    const handle = attachKeyboard(target as unknown as Window, buffer, DEFAULT_BINDINGS);
    expect(target.count('keydown')).toBe(1);

    handle.detach();
    expect(target.count('keydown')).toBe(0);
    expect(target.count('keyup')).toBe(0);
    expect(target.count('blur')).toBe(0);
  });
});

describe('bindings persist', () => {
  it('round-trips through storage', () => {
    const storage = fakeStorage();
    const custom: Bindings = { KeyI: Input.Throttle, KeyK: Input.Brake };

    saveBindings(storage, custom);
    expect(loadBindings(storage)).toEqual(custom);
  });

  it('falls back to the defaults when nothing is stored', () => {
    expect(loadBindings(fakeStorage())).toEqual(DEFAULT_BINDINGS);
  });

  it('survives storage being unavailable', () => {
    // Private browsing, a Worker, or a browser with storage disabled. None of
    // these should stop the game starting.
    expect(loadBindings(null)).toEqual(DEFAULT_BINDINGS);
    expect(loadBindings(undefined)).toEqual(DEFAULT_BINDINGS);
    expect(loadBindings(fakeStorage('throws'))).toEqual(DEFAULT_BINDINGS);
    expect(() => saveBindings(fakeStorage('throws'), DEFAULT_BINDINGS)).not.toThrow();
    expect(() => saveBindings(null, DEFAULT_BINDINGS)).not.toThrow();
  });

  it('rejects stored junk rather than trusting it', () => {
    // A stored binding is untrusted input like any other — another version of
    // the game, or a person with devtools, may have written it.
    const cases = ['not json', 'null', '[]', '"a string"', '{"KeyW": "throttle"}', '{}'];
    for (const raw of cases) {
      const storage = fakeStorage();
      storage.setItem('deadhead.bindings.v1', raw);
      expect(loadBindings(storage), raw).toEqual(DEFAULT_BINDINGS);
    }
  });

  it('drops unknown flags but keeps the valid ones', () => {
    const storage = fakeStorage();
    storage.setItem(
      'deadhead.bindings.v1',
      JSON.stringify({ KeyI: Input.Throttle, KeyZ: 0x400, KeyK: Input.Brake }),
    );
    expect(loadBindings(storage)).toEqual({ KeyI: Input.Throttle, KeyK: Input.Brake });
  });
});

describe('gamepad', () => {
  const pad = (overrides: {
    buttons?: readonly number[];
    values?: Readonly<Record<number, number>>;
    axes?: readonly number[];
  }): Gamepad =>
    ({
      buttons: Array.from({ length: 16 }, (_, i) => ({
        pressed: overrides.buttons?.includes(i) ?? false,
        value: overrides.values?.[i] ?? 0,
      })),
      axes: overrides.axes ?? [0, 0],
    }) as unknown as Gamepad;

  it('maps triggers, face buttons and the stick', () => {
    const buffer = new InputBuffer();
    pollGamepad(pad({ buttons: [7, 0], axes: [-1, 0] }), buffer);

    const byte = buffer.sample();
    expect(hasInput(byte, Input.Throttle)).toBe(true);
    expect(hasInput(byte, Input.Handbrake)).toBe(true);
    expect(hasInput(byte, Input.Left)).toBe(true);
  });

  it('reads analogue triggers, not just the pressed flag', () => {
    const buffer = new InputBuffer();
    pollGamepad(pad({ values: { 7: 0.8 } }), buffer);
    expect(hasInput(buffer.sample(), Input.Throttle)).toBe(true);
  });

  it('ignores a resting stick', () => {
    // Sticks do not return to exactly zero — a worn pad can rest at 0.15 — and
    // a cab that drifts left while nobody is touching anything reads as a
    // physics bug rather than a hardware one.
    const buffer = new InputBuffer();
    pollGamepad(pad({ axes: [0.15, 0] }), buffer);
    expect(buffer.sample()).toBe(0);
  });

  it('accepts the d-pad as well as the stick', () => {
    const buffer = new InputBuffer();
    pollGamepad(pad({ buttons: [15] }), buffer);
    expect(hasInput(buffer.sample(), Input.Right)).toBe(true);
  });

  it('does nothing without a pad', () => {
    const buffer = new InputBuffer();
    expect(() => pollGamepad(null, buffer)).not.toThrow();
    expect(() => pollGamepad(undefined, buffer)).not.toThrow();
    expect(buffer.sample()).toBe(0);
  });
});

describe('touch', () => {
  it('puts steering under the left thumb and pedals under the right', () => {
    const zones = touchZones();
    expect(zoneAt(zones, 0.05, 0.9)).toBe(Input.Left);
    expect(zoneAt(zones, 0.3, 0.9)).toBe(Input.Right);
    expect(zoneAt(zones, 0.9, 0.9)).toBe(Input.Throttle);
    expect(zoneAt(zones, 0.65, 0.9)).toBe(Input.Brake);
  });

  it('leaves the middle of the screen alone, because that is the game', () => {
    expect(zoneAt(touchZones(), 0.5, 0.2)).toBe(0);
  });

  it('follows a thumb that slides between zones', () => {
    // Re-evaluated per event rather than tracked by identifier: a thumb sliding
    // from brake to throttle should do the sensible thing instead of staying
    // latched to where it started.
    const buffer = new InputBuffer();
    const element = fakeTarget();
    attachTouch(element as unknown as HTMLElement, buffer, () => ({ width: 100, height: 100 }));

    element.emit('touchstart', { touches: [{ clientX: 65, clientY: 90 }] });
    expect(hasInput(buffer.sample(), Input.Brake)).toBe(true);

    element.emit('touchmove', { touches: [{ clientX: 90, clientY: 90 }] });
    const byte = buffer.sample();
    expect(hasInput(byte, Input.Throttle)).toBe(true);
    expect(hasInput(byte, Input.Brake)).toBe(false);
  });

  it('releases everything when the touch is cancelled', () => {
    // A call, a notification shade, a palm. The pedal must not stay down.
    const buffer = new InputBuffer();
    const element = fakeTarget();
    attachTouch(element as unknown as HTMLElement, buffer, () => ({ width: 100, height: 100 }));

    element.emit('touchstart', { touches: [{ clientX: 90, clientY: 90 }] });
    buffer.sample();
    element.emit('touchcancel', {});
    expect(buffer.sample()).toBe(0);
  });

  it('is resolution independent', () => {
    // Zones are fractions of the viewport, so the same thumb position works on
    // a phone and on a tablet.
    for (const [width, height] of [
      [360, 640],
      [1024, 768],
      [2400, 1080],
    ] as const) {
      const buffer = new InputBuffer();
      const element = fakeTarget();
      attachTouch(element as unknown as HTMLElement, buffer, () => ({ width, height }));
      element.emit('touchstart', { touches: [{ clientX: width * 0.9, clientY: height * 0.9 }] });
      expect(hasInput(buffer.sample(), Input.Throttle), `${width}x${height}`).toBe(true);
    }
  });
});
