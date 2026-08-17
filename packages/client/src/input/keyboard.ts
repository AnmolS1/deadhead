/**
 * `input/keyboard.ts` — keyboard into the buffer.
 */
import type { InputBuffer } from './buffer.js';
import type { Bindings } from './bindings.js';

export interface KeyboardHandle {
  /** Swap bindings without re-attaching listeners. */
  setBindings(bindings: Bindings): void;
  /** Remove every listener. */
  detach(): void;
}

/**
 * Route key events into the buffer.
 *
 * @param target usually `window`
 * @param onBlur also fires the buffer's `releaseAll`, because a key held while
 *   the tab loses focus never delivers its `keyup` — the cab would drive into a
 *   wall while the player reads their email.
 */
export function attachKeyboard(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  buffer: InputBuffer,
  initial: Bindings,
): KeyboardHandle {
  let bindings = initial;

  const down = (event: Event): void => {
    const key = event as KeyboardEvent;
    const flag = bindings[key.code];
    if (flag === undefined) return;
    // Prevent the page scrolling on space and the arrows. Only for keys we
    // actually use — swallowing every key would break browser shortcuts and
    // make the game a bad citizen on a page it does not own.
    key.preventDefault();
    buffer.press(flag);
  };

  const up = (event: Event): void => {
    const key = event as KeyboardEvent;
    const flag = bindings[key.code];
    if (flag !== undefined) buffer.release(flag);
  };

  const clear = (): void => buffer.releaseAll();

  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', clear);

  return {
    setBindings(next: Bindings): void {
      bindings = next;
      // Anything held under the old map would otherwise stay held forever.
      buffer.releaseAll();
    },
    detach(): void {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('blur', clear);
    },
  };
}
