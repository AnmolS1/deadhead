/**
 * `input/touch.ts` — thumbs into the buffer.
 *
 * Tap zones rather than a virtual wheel or tilt. `P-03` says touch controls for
 * an arcade drift model are genuinely hard and that at least two schemes should
 * be prototyped before committing — this is the first, and it is deliberately
 * the simplest thing that can work, so the second has something to beat.
 *
 * `DESIGN.md` §7.7 puts mobile **post-v1**, so this exists to keep the encoding
 * honest — three devices, one byte — rather than because touch is shipping.
 */
import { Input } from '@deadhead/proto';

import type { InputBuffer } from './buffer.js';

export interface TouchZone {
  readonly flag: number;
  /** Fractions of the viewport, so the layout is resolution-independent. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The default layout: steering under the left thumb, pedals under the right.
 *
 * Bottom-anchored and edge-hugging because that is where thumbs reach on a
 * phone held in landscape, and because the centre of the screen is where the
 * game is.
 */
export function touchZones(): readonly TouchZone[] {
  return [
    { flag: Input.Left, left: 0, top: 0.45, width: 0.2, height: 0.55 },
    { flag: Input.Right, left: 0.2, top: 0.45, width: 0.2, height: 0.55 },
    { flag: Input.Brake, left: 0.6, top: 0.45, width: 0.18, height: 0.55 },
    { flag: Input.Throttle, left: 0.78, top: 0.45, width: 0.22, height: 0.55 },
    { flag: Input.Handbrake, left: 0.4, top: 0.62, width: 0.2, height: 0.38 },
  ];
}

/** Which zone a normalised point falls in, or 0 for none. */
export function zoneAt(zones: readonly TouchZone[], x: number, y: number): number {
  for (const zone of zones) {
    if (
      x >= zone.left &&
      x < zone.left + zone.width &&
      y >= zone.top &&
      y < zone.top + zone.height
    ) {
      return zone.flag;
    }
  }
  return 0;
}

export interface TouchHandle {
  detach(): void;
}

/**
 * Route touches into the buffer.
 *
 * Every active touch is re-evaluated on each event rather than tracked by
 * identifier, which is both simpler and more forgiving: a thumb that slides
 * from the brake zone into the throttle zone does the sensible thing instead of
 * staying latched to where it started.
 */
export function attachTouch(
  element: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>,
  buffer: InputBuffer,
  viewport: () => { width: number; height: number },
  zones: readonly TouchZone[] = touchZones(),
): TouchHandle {
  const apply = (event: Event): void => {
    const touch = event as TouchEvent;
    touch.preventDefault();

    const { width, height } = viewport();
    buffer.releaseAll();

    for (let i = 0; i < touch.touches.length; i += 1) {
      const point = touch.touches[i];
      if (point === undefined) continue;
      const flag = zoneAt(zones, point.clientX / width, point.clientY / height);
      if (flag !== 0) buffer.press(flag);
    }
  };

  const clear = (): void => buffer.releaseAll();

  element.addEventListener('touchstart', apply, { passive: false });
  element.addEventListener('touchmove', apply, { passive: false });
  element.addEventListener('touchend', apply, { passive: false });
  element.addEventListener('touchcancel', clear);

  return {
    detach(): void {
      element.removeEventListener('touchstart', apply);
      element.removeEventListener('touchmove', apply);
      element.removeEventListener('touchend', apply);
      element.removeEventListener('touchcancel', clear);
    },
  };
}
