/**
 * `canvas.ts` — sizing a canvas so it is actually sharp.
 *
 * A canvas has two sizes and confusing them is the single most common reason a
 * browser game looks soft. The CSS size is how big it appears; the backing-store
 * size is how many pixels it actually has. On a 2x display they differ by a
 * factor of two, and a canvas that only sets one of them is either blurry or
 * drawn at a quarter scale.
 *
 * Everything here is float and DOM, and that is fine: this package renders. The
 * sim never sees any of it.
 */

/** The most backing-store pixels to allocate per CSS pixel. */
const MAX_PIXEL_RATIO = 2;

export interface Viewport {
  /** Backing-store width, in device pixels. */
  readonly width: number;
  /** Backing-store height, in device pixels. */
  readonly height: number;
  /** Device pixels per CSS pixel, after clamping. */
  readonly pixelRatio: number;
}

/**
 * Resize a canvas to fill its layout box at the display's pixel density.
 *
 * Capped at 2x on purpose. A 3x phone or a 4x monitor would otherwise allocate
 * nine or sixteen times the pixels for a flat-shaded game whose art has no
 * detail at that scale — see `D-02`. `P-02` has a frame-budget target, and this
 * is the cheapest way to protect it.
 *
 * @returns the new viewport, or `null` if nothing changed — so a caller can skip
 *   re-allocating render targets on every frame.
 */
export function resizeCanvas(canvas: HTMLCanvasElement): Viewport | null {
  const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const rect = canvas.getBoundingClientRect();

  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));

  if (canvas.width === width && canvas.height === height) return null;

  canvas.width = width;
  canvas.height = height;
  return { width, height, pixelRatio: ratio };
}

/**
 * Get a 2D context configured for this game.
 *
 * `alpha: false` lets the compositor skip blending the canvas against the page,
 * which is free performance for a game that paints every pixel every frame.
 */
export function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: false });
  if (context === null) throw new Error('canvas 2d context unavailable');
  return context;
}
