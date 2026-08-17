/**
 * `render/chunks.ts` — the pre-rendered ground.
 *
 * The road surface never changes during a run. Re-drawing it from the city's
 * edge list sixty times a second is the largest avoidable cost in the frame, so
 * it is drawn once per square of world into an offscreen canvas and thereafter
 * blitted. `C-04`'s brief calls this the single biggest perf win available, and
 * it is — but only once the memory is bounded, which took some arithmetic.
 *
 * ## Why this is an LRU with a byte budget, and not a map
 *
 * The obvious implementation caches every chunk of the city. For `W-03`'s
 * 1,200 × 1,200 city that is **400 MB at the most generous chunk size and
 * 1.6 GB at a realistic one** — it was never viable at any chunk size, so there
 * is no tuning that rescues the simple version.
 *
 * What actually bounds the cache is the *screen*, not the city. The pixels
 * needed are roughly
 *
 *     screen pixels ÷ zoom²  ×  slop for rotation and chunk edges
 *
 * which on a 1080p panel at device-pixel-ratio 2 is around 27 megapixels, or
 * ~109 MB. That is the honest floor for a full-screen ground cache, and it is
 * why {@link GroundCache} takes a **byte budget** and evicts against it rather
 * than assuming it can hold what it likes.
 *
 * ## The failure mode this is built to avoid
 *
 * If the budget is smaller than one frame's working set, a naive LRU evicts a
 * chunk and re-renders it on the very next frame — every frame, forever. That
 * is strictly *slower* than never caching at all, and from the outside it reads
 * as an unexplained frame-rate cliff on exactly the machines least able to
 * absorb it.
 *
 * So eviction here will **never drop a chunk that has been touched this frame**.
 * If the working set alone exceeds the budget, the cache goes over budget for
 * that frame and says so through {@link CacheStats.overBudget}, which `C-06`
 * surfaces. Going over a soft limit visibly beats thrashing invisibly.
 *
 * ## Why the cache is rendered at zoom 1
 *
 * `C-03` zooms between 1.0 and 0.78 — a 22% range. Rendering chunks at zoom 1
 * means the blit only ever scales *down*, by at most 22%, which costs nothing
 * and stays sharp. Continuous zoom over a wide range would have forced
 * power-of-two cache levels (mipmapping) to avoid rebuilding on every frame;
 * a 22% range makes that machinery unnecessary. If the zoom range is ever
 * widened, this comment is the thing that has to be revisited.
 */
import { type Bounds } from './viewport.js';

/**
 * Creates a backing surface for one chunk. `OffscreenCanvas` in the browser.
 *
 * The surface type is a **parameter**, not a fixed interface. The first draft
 * narrowed it to `{ width, height }` "for testability" and every test passed —
 * because the fake only ever needed those two fields. But a type narrowed past
 * what real code requires is one production can never use: `{ width, height }`
 * has no `getContext`, so nothing can paint into it, and it is not a
 * `CanvasImageSource`, so `drawImage` rejects it. The tests were green against
 * a shape the game could not have used.
 *
 * Making it generic fixes both ends without a cast at either. The cache never
 * touches the surface — it computes chunk dimensions itself — so `TSurface` is
 * unconstrained: the browser instantiates with `OffscreenCanvas` and gets a
 * fully typed blit, tests instantiate with a double.
 */
export type SurfaceFactory<TSurface> = (width: number, height: number) => TSurface;

/** Draws the static ground for one chunk. Called once per chunk, on a miss. */
export type ChunkPainter<TSurface> = (
  surface: TSurface,
  bounds: Bounds,
  chunkX: number,
  chunkY: number,
) => void;

export interface GroundCacheOptions<TSurface> {
  /** Side of one chunk, in world units. */
  readonly chunkUnits: number;
  /** Device pixels per world unit, at zoom 1. */
  readonly pixelsPerUnit: number;
  /** Soft ceiling on total cached bitmap bytes. */
  readonly budgetBytes: number;
  readonly createSurface: SurfaceFactory<TSurface>;
  readonly paint: ChunkPainter<TSurface>;
}

export interface CacheStats {
  /** Chunks currently held. */
  readonly count: number;
  /** Bytes currently held, at 4 bytes per pixel. */
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  /**
   * True if the last frame's working set alone exceeded the budget.
   *
   * Not an error — the cache deliberately goes over rather than thrashing — but
   * it means the budget is too small for this screen, and `C-06` shows it.
   */
  readonly overBudget: boolean;
}

/** One chunk's identity, packed so it can key a `Map`. */
function chunkKey(chunkX: number, chunkY: number): number {
  // Chunk coordinates are small signed integers; 16 bits each is far more than
  // a 1,200-unit city needs and keeps the key a Smi rather than a string.
  return ((chunkX & 0xffff) << 16) | (chunkY & 0xffff);
}

interface CachedChunk<TSurface> {
  readonly surface: TSurface;
  readonly bytes: number;
  /** The frame this was last used on, for the do-not-evict rule. */
  touchedFrame: number;
}

/**
 * A bounded cache of pre-rendered ground tiles.
 *
 * Usage per frame: call {@link beginFrame}, then {@link acquire} for every
 * chunk {@link chunksIn} reports as visible, then {@link endFrame}.
 */
export class GroundCache<TSurface> {
  private readonly options: GroundCacheOptions<TSurface>;
  /** Insertion-ordered, which is what makes it an LRU: re-inserting moves to the end. */
  private readonly chunks = new Map<number, CachedChunk<TSurface>>();

  private heldBytes = 0;
  private frame = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private wentOverBudget = false;

  constructor(options: GroundCacheOptions<TSurface>) {
    if (options.chunkUnits <= 0) throw new RangeError('chunkUnits must be positive');
    if (options.pixelsPerUnit <= 0) throw new RangeError('pixelsPerUnit must be positive');
    this.options = options;
  }

  /** Side of one chunk in device pixels. */
  get chunkPixels(): number {
    return Math.ceil(this.options.chunkUnits * this.options.pixelsPerUnit);
  }

  /** Bytes one chunk costs, at 4 bytes per pixel. */
  get bytesPerChunk(): number {
    const side = this.chunkPixels;
    return side * side * 4;
  }

  stats(): CacheStats {
    return {
      count: this.chunks.size,
      bytes: this.heldBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      overBudget: this.wentOverBudget,
    };
  }

  /** World bounds of a chunk. The inverse of the floor-divide in {@link chunksIn}. */
  boundsOf(chunkX: number, chunkY: number): Bounds {
    const size = this.options.chunkUnits;
    return {
      minX: chunkX * size,
      minY: chunkY * size,
      maxX: (chunkX + 1) * size,
      maxY: (chunkY + 1) * size,
    };
  }

  /**
   * Every chunk overlapping `bounds`, in a fixed order.
   *
   * The order is row-major and deterministic — not because the renderer needs
   * determinism (it does not; nothing here is hashed) but because a stable
   * order makes the LRU's behaviour reproducible, and a cache whose eviction
   * order changes run to run is one that cannot be tested.
   */
  *chunksIn(bounds: Bounds): Generator<{ readonly x: number; readonly y: number }> {
    const size = this.options.chunkUnits;
    const minX = Math.floor(bounds.minX / size);
    const maxX = Math.floor(bounds.maxX / size);
    const minY = Math.floor(bounds.minY / size);
    const maxY = Math.floor(bounds.maxY / size);

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        yield { x, y };
      }
    }
  }

  /** Start a frame. Resets the over-budget flag and advances the touch counter. */
  beginFrame(): void {
    this.frame += 1;
    this.wentOverBudget = false;
  }

  /**
   * The rendered surface for one chunk, painting it if it is not held.
   *
   * Touching a chunk marks it un-evictable for the rest of the frame, which is
   * what stops the cache from evicting something it is about to ask for again.
   */
  acquire(chunkX: number, chunkY: number): TSurface {
    const key = chunkKey(chunkX, chunkY);
    const existing = this.chunks.get(key);

    if (existing !== undefined) {
      this.hits += 1;
      existing.touchedFrame = this.frame;
      // Re-insert to move to the end of the eviction order.
      this.chunks.delete(key);
      this.chunks.set(key, existing);
      return existing.surface;
    }

    this.misses += 1;
    const side = this.chunkPixels;
    const surface = this.options.createSurface(side, side);
    this.options.paint(surface, this.boundsOf(chunkX, chunkY), chunkX, chunkY);

    const entry: CachedChunk<TSurface> = {
      surface,
      bytes: this.bytesPerChunk,
      touchedFrame: this.frame,
    };
    this.chunks.set(key, entry);
    this.heldBytes += entry.bytes;

    this.evictToBudget();
    return surface;
  }

  /** End a frame. Evicts anything the frame did not need, down to the budget. */
  endFrame(): void {
    this.evictToBudget();
  }

  /** Drop everything. For a resize, a zoom-range change, or a city reload. */
  invalidate(): void {
    this.chunks.clear();
    this.heldBytes = 0;
  }

  /**
   * Evict least-recently-used chunks until the budget is met.
   *
   * Skips anything touched this frame. If that alone busts the budget the cache
   * stays over and flags it — see the module comment on why that beats
   * evicting a chunk the very next `acquire` will re-render.
   */
  private evictToBudget(): void {
    if (this.heldBytes <= this.options.budgetBytes) return;

    for (const [key, entry] of this.chunks) {
      if (this.heldBytes <= this.options.budgetBytes) return;
      // The rule that prevents thrashing: never drop what this frame is using.
      if (entry.touchedFrame === this.frame) continue;

      this.chunks.delete(key);
      this.heldBytes -= entry.bytes;
      this.evictions += 1;
    }

    // Still over, and everything left is in use. Say so rather than thrash.
    if (this.heldBytes > this.options.budgetBytes) this.wentOverBudget = true;
  }
}

/**
 * A budget that fits the screen, with room for rotation and chunk overhang.
 *
 * The derivation, so it is not a magic number: a full screen of ground at the
 * widest zoom needs `width × height ÷ zoom²` pixels, and a rotated view's
 * axis-aligned cover is up to 2× that in area at 45°.
 *
 * **The factor is a bound, not a measurement.** It is the full 2× because
 * that is the worst case and nothing here has been profiled on real hardware;
 * do not record it anywhere as derived.
 *
 * An earlier version used 1.6 and justified it as "chunk-level culling recovers
 * most of the rotation slop" — but {@link GroundCache.chunksIn} floor-divides
 * the AABB and yields every chunk in that rectangle, with no per-chunk test
 * against the rotated quad. The mitigation did not exist. A comment asserting a
 * mitigation the code lacks is exactly the defect that made `C-03` and `C-04`
 * disagree about rotation in the first place.
 *
 * Erring high is the cheap direction: this is a soft ceiling with an LRU behind
 * it, so over-provisioning costs headroom while under-provisioning surfaces as
 * `overBudget` on real hardware for no visible reason. Worth knowing it *is*
 * over-provisioned in practice — `C-03` rotates to heading, so the view sits at
 * the 45° worst case only in passing, never continuously.
 *
 * If per-chunk quad culling is added later (a SAT test against the four view
 * corners, using the already-exported `overlaps` and a quad from the viewport),
 * this factor can come back down — and only then.
 */
export function suggestedBudgetBytes(
  screenWidth: number,
  screenHeight: number,
  minZoom = 0.78,
): number {
  const pixels = (screenWidth * screenHeight) / (minZoom * minZoom);
  return Math.ceil(pixels * 2 * 4);
}
