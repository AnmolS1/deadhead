/**
 * `input/bindings.ts` — which key does what, and where that is remembered.
 *
 * Remappable because `G-09` requires it, and because the default layout assumes
 * a keyboard the player may not have: WASD is meaningless on AZERTY and hostile
 * on Dvorak. Bindings are stored by **`KeyboardEvent.code`**, not `key` —
 * `code` is the physical position, so a default binding of `KeyW` is the same
 * physical key on every layout, and a French player gets the key under their
 * finger rather than the letter W.
 */
import { Input } from '@deadhead/proto';

/** Where the player's bindings live. Versioned, so a format change is a reset rather than a crash. */
export const BINDINGS_STORAGE_KEY = 'deadhead.bindings.v1';

/** `KeyboardEvent.code` → input flag. */
export type Bindings = Readonly<Record<string, number>>;

/**
 * The default layout: WASD and the arrows both drive, space is the handbrake.
 *
 * Both hands are bound by default rather than offering a choice, because a
 * first-time player should never have to find a settings screen to move.
 */
export const DEFAULT_BINDINGS: Bindings = {
  KeyW: Input.Throttle,
  ArrowUp: Input.Throttle,
  KeyS: Input.Brake,
  ArrowDown: Input.Brake,
  KeyA: Input.Left,
  ArrowLeft: Input.Left,
  KeyD: Input.Right,
  ArrowRight: Input.Right,
  Space: Input.Handbrake,
  KeyH: Input.Hail,
};

/** Every flag a binding may map to. Anything else is refused rather than stored. */
const VALID_FLAGS = new Set<number>(Object.values(Input));

/**
 * Read the player's bindings, falling back to the defaults.
 *
 * Never throws. Storage can be unavailable (private browsing, a Worker), full,
 * or hold something another version of the game wrote — and none of those are
 * worth failing to start the game over.
 */
export function loadBindings(storage: Storage | null | undefined): Bindings {
  if (storage === null || storage === undefined) return DEFAULT_BINDINGS;

  let raw: string | null;
  try {
    raw = storage.getItem(BINDINGS_STORAGE_KEY);
  } catch {
    return DEFAULT_BINDINGS;
  }
  if (raw === null) return DEFAULT_BINDINGS;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_BINDINGS;
    }

    const bindings: Record<string, number> = {};
    for (const [code, flag] of Object.entries(parsed as Record<string, unknown>)) {
      // A stored binding is untrusted input like any other. A flag outside the
      // known set would be masked away downstream anyway, but silently keeping
      // it means a settings screen shows a control that does nothing.
      if (typeof flag === 'number' && VALID_FLAGS.has(flag)) bindings[code] = flag;
    }
    return Object.keys(bindings).length > 0 ? bindings : DEFAULT_BINDINGS;
  } catch {
    return DEFAULT_BINDINGS;
  }
}

/** Persist bindings. Silently does nothing if storage refuses — this is a preference, not data. */
export function saveBindings(storage: Storage | null | undefined, bindings: Bindings): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // Quota, private mode, disabled storage. None of these should stop play.
  }
}
