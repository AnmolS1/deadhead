/**
 * `input/` — every device, one byte per tick.
 *
 * Keyboard, gamepad and touch all write into a single {@link InputBuffer}, so
 * `C-02`'s "all three produce identical bytes for equivalent actions" holds by
 * construction rather than because three code paths happen to agree. Nothing
 * downstream can tell which device a run was played on, which is what makes a
 * recorded log portable between them.
 */
export { InputBuffer } from './buffer.js';
export {
  BINDINGS_STORAGE_KEY,
  DEFAULT_BINDINGS,
  loadBindings,
  saveBindings,
  type Bindings,
} from './bindings.js';
export { attachKeyboard } from './keyboard.js';
export { pollGamepad, GAMEPAD_DEADZONE } from './gamepad.js';
export { attachTouch, touchZones, type TouchZone } from './touch.js';
