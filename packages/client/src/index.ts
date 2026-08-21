/**
 * @deadhead/client — canvas renderer, input, audio and UI.
 *
 * This package reads sim state and never mutates it. Floats are allowed here
 * and nowhere upstream.
 *
 * The render modules are re-exported because `W-02`'s city editor is specified
 * to *reuse the game renderer*. Without a package entry point it would have to
 * reimplement the world/screen transform in `tools/cityedit/`, which is exactly
 * the duplication that putting the transform in `render/viewport.ts` — rather
 * than in `camera.ts` — was meant to prevent.
 */
import { SIM_VERSION } from '@deadhead/sim';

export const CLIENT_VERSION = 0;

export { SIM_VERSION };

export {
  applyCamera,
  containsPoint,
  overlaps,
  screenToWorld,
  visibleBounds,
  worldToScreen,
  type Bounds,
  type CameraTarget,
  type ViewportState,
} from './render/viewport.js';

export {
  GroundCache,
  suggestedBudgetBytes,
  type CacheStats,
  type ChunkPainter,
  type GroundCacheOptions,
  type SurfaceFactory,
} from './render/chunks.js';

export {
  CullMargins,
  LAYERS,
  cullRatio,
  emptyFrameStats,
  renderScene,
  totalConsidered,
  totalDrawn,
  type Drawable,
  type FrameContext,
  type FrameInput,
  type FrameStats,
  type Layer,
} from './render/scene.js';

export {
  angleToRadians,
  lerp,
  lerpAngle,
  lerpFixed,
  lerpPose,
  separation,
  shouldInterpolate,
  type Pose,
} from './render/interp.js';
