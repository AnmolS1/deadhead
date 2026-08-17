/**
 * `input/gamepad.ts` — a pad into the buffer.
 *
 * Polled rather than event-driven, because the Gamepad API has no events for
 * button state — you read a snapshot. Polling happens once per frame and the
 * buffer latches, so a button pressed and released between two ticks still
 * registers exactly as a keyboard tap would.
 */
import { Input } from '@deadhead/proto';

import type { InputBuffer } from './buffer.js';

/**
 * Stick movement below this is ignored.
 *
 * Sticks do not return to exactly zero — a worn pad can rest at 0.15 — and a
 * cab that drifts left while nobody is touching anything reads as a physics bug
 * rather than as a hardware one.
 */
export const GAMEPAD_DEADZONE = 0.25;

/** Analogue trigger travel counted as a press. */
const TRIGGER_THRESHOLD = 0.3;

/**
 * Read one pad and write it into the buffer.
 *
 * Standard mapping: right trigger throttles, left trigger brakes, A is the
 * handbrake, the left stick and the d-pad both steer.
 */
export function pollGamepad(pad: Gamepad | null | undefined, buffer: InputBuffer): void {
  if (pad === null || pad === undefined) return;

  const button = (index: number): boolean => pad.buttons[index]?.pressed === true;
  const analogue = (index: number): number => pad.buttons[index]?.value ?? 0;

  buffer.releaseAll();

  if (button(7) || analogue(7) > TRIGGER_THRESHOLD) buffer.press(Input.Throttle);
  if (button(6) || analogue(6) > TRIGGER_THRESHOLD) buffer.press(Input.Brake);
  if (button(0)) buffer.press(Input.Handbrake);
  if (button(3)) buffer.press(Input.Hail);

  const stick = pad.axes[0] ?? 0;
  if (stick < -GAMEPAD_DEADZONE || button(14)) buffer.press(Input.Left);
  if (stick > GAMEPAD_DEADZONE || button(15)) buffer.press(Input.Right);
}
