/**
 * `render/viewport.ts` — what is on screen, and where.
 *
 * Two jobs: convert between world and screen space, and work out what can be
 * skipped. The second is the one that matters. `C-04`'s done-when is 60 fps with
 * twelve cars, forty NPCs and two hundred particles, and the way a Canvas 2D
 * game reaches that is not by drawing faster — it is by not drawing.
 *
 * ## Culling has to account for rotation
 *
 * The camera can rotate (`C-03`), and a rotated rectangle covers a **larger**
 * axis-aligned area than an unrotated one — up to √2 times at 45°. Culling
 * against the unrotated rectangle would pop the corners of the screen: geometry
 * that is genuinely visible gets skipped, and only when the camera is turned,
 * which is exactly the kind of bug that survives a straight-line playtest.
 *
 * {@link visibleBounds} returns the world-space AABB of the *rotated* view, so
 * the cull is conservative in the correct direction: it may keep something just
 * off screen, and it will never drop something on it.
 *
 * ## Everything here is float
 *
 * Render-side, so the ±181 squaring bound (ADR 0003) does not apply — these are
 * doubles, not 16.16, and nothing computed here is hashed or transmitted.
 */

/** An axis-aligned rectangle in world units. */
export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** What the renderer needs to know about the frame it is drawing. */
export interface ViewportState {
  /** Centre of the view, world units. */
  readonly x: number;
  readonly y: number;
  /** Camera rotation, radians. Zero when rotation is off. */
  readonly rotation: number;
  /** Camera zoom multiplier. Below 1 means a wider view. */
  readonly zoom: number;
  /** Backing-store size, device pixels. */
  readonly width: number;
  readonly height: number;
  /** Device pixels per world unit at zoom 1. */
  readonly pixelsPerUnit: number;
}

/**
 * World-space AABB of everything the camera can see, plus a margin.
 *
 * The margin is in world units and exists so a cab, a building or a particle
 * that straddles the edge is drawn rather than popping in when its centre
 * crosses. Callers pass the largest radius in the layer they are culling.
 */
export function visibleBounds(view: ViewportState, margin = 0): Bounds {
  const scale = view.zoom * view.pixelsPerUnit;
  // Half the view, in world units.
  const halfWidth = view.width / 2 / scale;
  const halfHeight = view.height / 2 / scale;

  // A rotated rectangle's axis-aligned extent. At 0° this is exactly the
  // rectangle; at 45° it is about √2 times larger on both axes. Culling against
  // the unrotated box would drop the corners of a turned screen.
  const cos = Math.abs(Math.cos(view.rotation));
  const sin = Math.abs(Math.sin(view.rotation));
  const extentX = halfWidth * cos + halfHeight * sin + margin;
  const extentY = halfWidth * sin + halfHeight * cos + margin;

  return {
    minX: view.x - extentX,
    minY: view.y - extentY,
    maxX: view.x + extentX,
    maxY: view.y + extentY,
  };
}

/** True if the two rectangles overlap at all. Touching edges count. */
export function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * True if a point is inside, allowing for something of the given radius.
 *
 * The common case for cars, passengers and particles, which are points with a
 * size rather than boxes.
 */
export function containsPoint(bounds: Bounds, x: number, y: number, radius = 0): boolean {
  return (
    x + radius >= bounds.minX &&
    x - radius <= bounds.maxX &&
    y + radius >= bounds.minY &&
    y - radius <= bounds.maxY
  );
}

/**
 * The three operations {@link applyCamera} needs from a context.
 *
 * Deliberately a structural subset rather than `CanvasRenderingContext2D`.
 * A real canvas satisfies it and so does `scene.ts`'s `FrameContext`, which
 * means the frame renderer can pass its context straight through — where it
 * previously needed `context as unknown as CanvasRenderingContext2D`, a double
 * cast that silently defeated the entire point of having a testable context
 * type. With the cast, any future divergence between the two would compile
 * clean and fail only in a browser.
 */
export interface CameraTarget {
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
}

/**
 * Apply the camera to a context.
 *
 * The order is the contract, and it is written once, here, rather than
 * duplicated in every layer:
 *
 * 1. move the origin to the centre of the canvas,
 * 2. rotate by the *negative* camera rotation,
 * 3. scale by zoom × pixels-per-unit,
 * 4. translate so the camera centre lands at the origin.
 *
 * ## What `rotation` means, precisely
 *
 * **It is how far the world is turned, not a direction.** Zero draws the world
 * unrotated: +X to the right, +Y down the screen. A world direction θ appears
 * on screen at angle `θ − rotation`, measured from +X with y downward.
 *
 * Stated that carefully because the loose version — "the angle that ends up at
 * the top of the screen" — is wrong by a quarter turn and reads as if it were
 * right. Straight up the screen is `−π/2` in that frame, so a camera that wants
 * the cab pointing up sets `rotation = heading + π/2`, which is exactly what
 * `C-03` does. The first draft of this file documented the loose version, and
 * only a test asserting a specific screen coordinate caught it.
 */
export function applyCamera(context: CameraTarget, view: ViewportState): void {
  const scale = view.zoom * view.pixelsPerUnit;
  context.translate(view.width / 2, view.height / 2);
  context.rotate(-view.rotation);
  context.scale(scale, scale);
  context.translate(-view.x, -view.y);
}

/**
 * Where a world point lands on screen, in device pixels.
 *
 * For the few things that are positioned in world space but drawn in screen
 * space — `W-06`'s street signs, a name label over a cab — and for `C-06`'s
 * overlay. Layers that draw in world space should use {@link applyCamera} and
 * forget screen coordinates entirely.
 */
export function worldToScreen(
  view: ViewportState,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  const scale = view.zoom * view.pixelsPerUnit;
  const dx = (x - view.x) * scale;
  const dy = (y - view.y) * scale;

  const cos = Math.cos(-view.rotation);
  const sin = Math.sin(-view.rotation);

  return {
    x: view.width / 2 + dx * cos - dy * sin,
    y: view.height / 2 + dx * sin + dy * cos,
  };
}

/** The inverse of {@link worldToScreen}. For picking, and for `W-02`'s editor. */
export function screenToWorld(
  view: ViewportState,
  screenX: number,
  screenY: number,
): { readonly x: number; readonly y: number } {
  const scale = view.zoom * view.pixelsPerUnit;
  const dx = screenX - view.width / 2;
  const dy = screenY - view.height / 2;

  const cos = Math.cos(view.rotation);
  const sin = Math.sin(view.rotation);

  return {
    x: view.x + (dx * cos - dy * sin) / scale,
    y: view.y + (dx * sin + dy * cos) / scale,
  };
}
