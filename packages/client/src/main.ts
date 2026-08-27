/**
 * `main.ts` — the app shell.
 *
 * Wires three things together and does nothing else:
 *
 * 1. a canvas, sized for the display (`canvas.ts`),
 * 2. the fixed-timestep accumulator (`loop.ts`),
 * 3. the sim.
 *
 * The shape to notice is in `frame()`: `requestAnimationFrame` gives a
 * timestamp, the accumulator converts it into a **count**, and the sim is
 * stepped exactly that many times with no argument derived from wall time.
 * Rendering then happens once, with `alpha`. That separation is `C-01`, and
 * everything in Phases 4, 5 and 6 depends on it holding.
 *
 * The renderer here is a placeholder — `C-04` replaces it. What is real is the
 * loop.
 */
import { packCity, type CityJson } from '@deadhead/proto';
import {
  Car,
  CarFlags,
  ClockTuning,
  FX_ONE,
  beginFare,
  createWorld,
  emptyCity,
  endFare,
  fxFromInt,
  NO_PASSENGER,
  Passenger,
  getCar,
  getPassenger,
  isCarrying,
  prepareCity,
  setCar,
  step,
  type RuntimeCity,
  type World,
} from '@deadhead/sim';

import { AudioEngine } from './audio/index.js';
import { feelFor } from './feel/index.js';
import { interpolatedEye } from './camera.js';
import { getContext, resizeCanvas, type Viewport } from './canvas.js';
import {
  InputBuffer,
  attachKeyboard,
  attachTouch,
  loadBindings,
  pollGamepad,
} from './input/index.js';
import { FixedTimestepLoop } from './loop.js';
import { GroundCache, suggestedBudgetBytes } from './render/chunks.js';
import { paintCity } from './render/city.js';
import { Ink } from './render/palette.js';
import { newFeelMemory, renderFeel } from './render/feel.js';
import { renderMinimap, type MinimapEdge } from './render/minimap.js';
import { renderScene, type FrameContext } from './render/scene.js';
import { type ViewportState } from './render/viewport.js';

/** Everything a running game needs. `G-01` gives this a real lifecycle. */
interface Session {
  /** State at the end of the last completed tick. */
  current: World;
  /** State one tick earlier, for `C-05` to interpolate against. */
  previous: World;
  readonly loop: FixedTimestepLoop;
  readonly input: InputBuffer;
  readonly city: CityJson | null;
  readonly ground: GroundCache<OffscreenCanvas> | null;
}

/** Device pixels per world unit at zoom 1, before the display's pixel ratio. */
const PIXELS_PER_UNIT = 8;

/**
 * A zoom override, for looking at the city rather than playing it.
 *
 * `?scale=3` frames a whole district; the default frames the road ahead. Purely
 * a development affordance — `C-06`'s overlay will want it, and `W-05` needed
 * it to check the "reads as one coherent world" half of its done-when, which
 * cannot be judged from two blocks of street.
 */
function scaleOverride(): number {
  const value = Number(new URLSearchParams(location.search).get('scale'));
  return Number.isFinite(value) && value > 0 ? value : PIXELS_PER_UNIT;
}

/** Side of one pre-rendered ground chunk, in world units. */
const CHUNK_UNITS = 96;

/**
 * Where the camera was placed on the last frame. Dev-only, and the only way to
 * observe that the camera interpolates: the sim position steps at `TICK_HZ`, so
 * reading it tells you nothing about what was drawn.
 */
let lastEye: { x: number; y: number } = { x: 0, y: 0 };

function start(canvas: HTMLCanvasElement, cityJson: CityJson | null): void {
  const context = getContext(canvas);
  let viewport: Viewport = resizeCanvas(canvas) ?? {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: 1,
  };

  const runtime: RuntimeCity = cityJson === null ? emptyCity() : prepareCity(packCity(cityJson));
  const world = createWorld(20260821, 1, runtime);

  // Put the cab on a road. `G-01` owns this properly — a seeded junction,
  // biased toward the middle — but a cab left at the origin is inside a
  // building in City 01, and a demo that opens wedged in a wall is no demo.
  if (cityJson !== null && cityJson.nodes.length > 0) {
    const node = cityJson.nodes[Math.floor(cityJson.nodes.length / 2)]!;
    setCar(world, 0, Car.X, fxFromInt(node.x));
    setCar(world, 0, Car.Y, fxFromInt(node.y));
  }

  const pixelsPerUnit = scaleOverride() * viewport.pixelRatio;
  const session: Session = {
    current: world,
    previous: world,
    loop: new FixedTimestepLoop(),
    input: new InputBuffer(),
    city: cityJson,
    ground:
      cityJson === null
        ? null
        : new GroundCache<OffscreenCanvas>({
            chunkUnits: CHUNK_UNITS,
            pixelsPerUnit,
            budgetBytes: suggestedBudgetBytes(canvas.width, canvas.height),
            createSurface: (w, h) => new OffscreenCanvas(w, h),
            paint: (surface, bounds) => {
              const ctx = surface.getContext('2d');
              if (ctx === null) return;

              // Fill the WHOLE surface first, in canvas space.
              //
              // A chunk canvas is `ceil(chunkUnits * pixelsPerUnit)` pixels, so
              // when that product is fractional there is a sliver of canvas
              // past the world rectangle the painter covers. Left transparent,
              // resampling smears it into a visible seam at every chunk
              // boundary — a grid of faint lines across the whole city, which
              // is exactly what this looked like before.
              //
              // Painting the bleed in the paper colour means the seam blends
              // paper into paper and disappears.
              ctx.fillStyle = Ink.paper;
              ctx.fillRect(0, 0, surface.width, surface.height);

              // Chunk space: world units, with the chunk's corner at the origin.
              ctx.scale(pixelsPerUnit, pixelsPerUnit);
              ctx.translate(-bounds.minX, -bounds.minY);
              paintCity(ctx, cityJson, { bounds, scale: pixelsPerUnit });
            },
          }),
  };

  attachKeyboard(window, session.input, loadBindings(safeLocalStorage()));
  attachTouch(canvas, session.input, () => ({ width: viewport.width, height: viewport.height }));

  // `C-07`. **The context must be created inside a real user gesture.** A
  // context built here, at start-up, is left `suspended` by autoplay policy and
  // never produces a sound — and nothing throws and nothing logs, so the only
  // symptom is silence. Hence the listeners below rather than a call here.
  const audio = new AudioEngine(safeLocalStorage());
  const wake = (): void => audio.start();
  for (const type of ['keydown', 'pointerdown', 'touchstart'] as const) {
    // Not `{ once: true }`: a context can be suspended again when the tab is
    // hidden or audio focus is lost, and resuming is gesture-gated too. Every
    // gesture is a chance to recover, and `start()` is idempotent.
    window.addEventListener(type, wake, { passive: true });
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'm' || event.key === 'M') audio.toggleMute();
  });

  // Dev affordance, not a feature. Web Audio cannot be tested in node or
  // workerd, so the ONLY way to check the mix in the thing that actually makes
  // sound is to read it out of the page. `C-08` tunes against this and `C-06`'s
  // overlay wants the same numbers.
  //
  // Gated on the host rather than `import.meta.env.DEV`, which needs Vite's
  // client types — and `HANDOFF.md` is explicit that this repo carries no
  // ambient type packages it can avoid. A hostname check needs none and is
  // honest about what it does.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    (window as unknown as { deadhead?: unknown }).deadhead = {
      audio,
      mix: () => audio.lastMix,
      world: () => session.current,
      eye: () => lastEye,
      /** Decoded cab state. Raw `world.data` needs the header offset and the
       *  car stride, and getting either wrong yields plausible-looking
       *  nonsense — which is worse than an error. */
      car: () => {
        const w = session.current;
        const vx = getCar(w, 0, Car.VelocityX) / FX_ONE;
        const vy = getCar(w, 0, Car.VelocityY) / FX_ONE;
        return {
          x: getCar(w, 0, Car.X) / FX_ONE,
          y: getCar(w, 0, Car.Y) / FX_ONE,
          headingTurn: getCar(w, 0, Car.Heading),
          headingDeg: (getCar(w, 0, Car.Heading) / 65536) * 360,
          vx,
          vy,
          speedPerTick: Math.hypot(vx, vy),
          speedPerSecond: Math.hypot(vx, vy) * 30,
          flags: getCar(w, 0, Car.Flags),
          drifting: (getCar(w, 0, Car.Flags) & CarFlags.Drifting) !== 0,
          lastInput: getCar(w, 0, Car.LastInput),
        };
      },
      /**
       * Set the deadhead bank to a fraction of full, so the fold can be seen at
       * any point in a run without waiting three minutes for it. `C-08` is
       * tuned against this — a feel pass that can only be observed in real time
       * is a feel pass nobody iterates on.
       */
      drain: (fraction: number) => {
        setCar(
          session.current,
          0,
          Car.DeadheadTicks,
          Math.round(ClockTuning.startingDeadheadTicks * fraction),
        );
      },
      /**
       * Force the carrying state, for looking at the empty-vs-carrying contrast
       * without hunting a passenger down first.
       *
       * **This holds for ONE tick unless passenger `index` is genuinely
       * waiting.** `stepFares` -> `resolveBails` ends any fare whose passenger
       * has no patience left, and a passenger that was never spawned has
       * `PatienceTicks` of zero — so a faked pickup is reverted immediately and
       * the cab silently goes back to empty while the bank keeps draining. That
       * cost a confusing screenshot: the world looked right, then eliminated
       * itself half a minute later.
       *
       * Uses `beginFare` rather than writing `CarriedPassenger`, so the fare
       * clock resets the way a real pickup does. Returns whether it stuck.
       */
      carry: (on: boolean, index = 0): boolean => {
        if (on) beginFare(session.current, 0, index);
        else endFare(session.current, 0, false);
        return isCarrying(session.current, 0);
      },
    };
  }

  const inputs = [0];
  const feelMemory = newFeelMemory();

  // Road segments in world units, resolved once. The city never changes during a
  // run, so rebuilding this per frame would be pure waste.
  const minimapEdges: MinimapEdge[] =
    cityJson === null
      ? []
      : cityJson.edges.flatMap((edge) => {
          const a = cityJson.nodes[edge.a];
          const b = cityJson.nodes[edge.b];
          return a === undefined || b === undefined ? [] : [{ a, b }];
        });
  let lastFrameMs = 0;

  const frame = (timestampMs: number): void => {
    const resized = resizeCanvas(canvas);
    if (resized !== null) viewport = resized;

    // Polled once a frame; the buffer latches, so a button pressed and released
    // between two ticks still reaches the sim.
    pollGamepad(navigator.getGamepads?.()[0] ?? null, session.input);

    const { steps, alpha } = session.loop.advance(timestampMs);

    for (let i = 0; i < steps; i += 1) {
      // Sampled once per tick, inside the loop. Sampling once per *frame* would
      // hand several ticks the same byte during catch-up, and hand none of them
      // the taps that happened in between.
      inputs[0] = session.input.sample();
      // The previous state is kept so C-05 can render between the two. This is
      // free because step() returns a copy and never mutates (ADR 0004).
      session.previous = session.current;
      session.current = step(session.current, inputs);
    }

    // Audio reads the SAME state the renderer draws, once a frame. Driving it
    // from inside the tick loop would push several updates per frame during
    // catch-up and ramp the mix against stale wall-clock time; the mix is a
    // presentation concern, like `alpha`, not a simulation one.
    const vx = getCar(session.current, 0, Car.VelocityX) / FX_ONE;
    const vy = getCar(session.current, 0, Car.VelocityY) / FX_ONE;
    audio.update({
      carrying: isCarrying(session.current, 0),
      deadheadTicks: getCar(session.current, 0, Car.DeadheadTicks),
      speedPerTick: Math.hypot(vx, vy),
      eliminated: (getCar(session.current, 0, Car.Flags) & CarFlags.Eliminated) !== 0,
    });

    render(context, viewport, session, alpha);

    // `C-08`, drawn over the finished scene in screen space. The dt here is
    // real wall time and that is correct — this is presentation easing, and the
    // sim never sees it (hard invariant #2).
    const dtSeconds = lastFrameMs === 0 ? 0 : (timestampMs - lastFrameMs) / 1000;
    lastFrameMs = timestampMs;
    const feel = feelFor({
      carrying: isCarrying(session.current, 0),
      deadheadTicks: getCar(session.current, 0, Car.DeadheadTicks),
      eliminated: (getCar(session.current, 0, Car.Flags) & CarFlags.Eliminated) !== 0,
    });

    renderFeel(
      context,
      { width: viewport.width, height: viewport.height },
      feel,
      feelMemory,
      dtSeconds,
    );

    // `W-06`. Drawn last so the fold never eats it, and positioned from the same
    // insets so it rides the closing field instead of being occluded by it.
    if (session.city !== null && !feel.ended) {
      renderMinimap(
        context as unknown as Parameters<typeof renderMinimap>[0],
        { width: viewport.width, height: viewport.height },
        {
          eye: lastEye,
          edges: minimapEdges,
          landmarks: session.city.landmarks,
          destination: activeDestination(session),
          insets: feel.insets,
        },
      );
    }

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

/**
 * The destination of the fare currently aboard, or `null` when the cab is empty.
 *
 * `Passenger.Destination` is an index into the city's destination list — its own
 * comment says "`W-06` names it", and this is that. Until now **all 19
 * destinations were drawn identically**, so a carrying player had no way to tell
 * which was theirs: the target was not hidden, it was indistinguishable from
 * eighteen decoys. That is what Anmol's playtest reported.
 */
function activeDestination(session: Session): { x: number; y: number } | null {
  if (session.city === null) return null;
  const passenger = getCar(session.current, 0, Car.CarriedPassenger);
  if (passenger === NO_PASSENGER) return null;
  const index = getPassenger(session.current, passenger, Passenger.Destination);
  return session.city.destinations[index] ?? null;
}

/**
 * One frame.
 *
 * The camera follows the cab without rotating — `C-03`'s rotation is available
 * and deliberately not used here, because a rotating world plus a folded-paper
 * aesthetic reads as a sheet being turned over rather than a car going round a
 * corner. `C-08`'s feel pass is where that gets decided properly.
 */
function render(
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  session: Session,
  alpha: number,
): void {
  // The camera follows the INTERPOLATED cab, not the last completed tick —
  // see `interpolatedEye`, which carries the whole explanation and the test.
  const eye = interpolatedEye(session.previous, session.current, 0, alpha);
  const x = eye.x;
  const y = eye.y;
  lastEye = eye;

  const view: ViewportState = {
    x,
    y,
    rotation: 0,
    zoom: 1,
    width: viewport.width,
    height: viewport.height,
    pixelsPerUnit: scaleOverride() * viewport.pixelRatio,
  };

  // The paper, everywhere the city is not — so the edges of the world are the
  // same sheet rather than a void.
  context.fillStyle = Ink.paper;
  context.fillRect(0, 0, viewport.width, viewport.height);

  const frame = context as unknown as FrameContext;
  const ground = session.ground;

  const base = {
    previous: session.previous,
    current: session.current,
    view,
    alpha,
    ...(session.city === null ? {} : { cityJson: session.city }),
  };

  if (ground === null) {
    renderScene<OffscreenCanvas>(frame, base);
    return;
  }

  renderScene<OffscreenCanvas>(frame, {
    ...base,
    ground: {
      cache: ground,
      blit: (_ctx, surface, bounds) => {
        // Chunks are rendered at zoom 1, so the blit only ever scales down
        // (chunks.ts). Drawn in world units — the camera transform is already
        // on the context.
        //
        // **Overlapped by a device pixel**, which is what stops a faint grid of
        // seams appearing across the whole city. A chunk canvas is
        // `ceil(units * pixelsPerUnit)` pixels and is blitted to a fractional
        // destination, so its edges resample against nothing and every chunk
        // boundary picks up a hairline. Painting a paper bleed into the
        // overhang reduces it; only overlapping removes it, because then the
        // neighbour covers the resampled edge entirely.
        const bleed = 1 / (view.zoom * view.pixelsPerUnit);
        context.drawImage(
          surface,
          bounds.minX,
          bounds.minY,
          bounds.maxX - bounds.minX + bleed,
          bounds.maxY - bounds.minY + bleed,
        );
      },
    },
  });
}

/** `localStorage` throws on access in some privacy modes rather than returning null. */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (canvas === null) throw new Error('no #game canvas on the page');

/**
 * Load the city, then start.
 *
 * Same-origin and bundled — `no-thirdparty.sh` fails the build on any external
 * origin, so the city ships as an asset beside the game rather than being
 * fetched from anywhere.
 */
/**
 * `?city=none` — start with no city at all.
 *
 * A dev affordance in the same family as `?scale=`. Measuring the car model in
 * City 01 measures the car model *and the buildings*: a run at top speed ends
 * against a wall within a couple of seconds, so speed and heading readings are
 * really collision readings. `createWorld` already accepts `emptyCity()`, so a
 * blank field costs one branch and makes handling observable in isolation.
 *
 * Anmol asked for this while `S-06`'s turn radius was being measured, and it
 * immediately changed the numbers — see the note in `TASKS.md`.
 */
const blankCity = new URLSearchParams(location.search).get('city') === 'none';

void (
  blankCity
    ? Promise.resolve(null)
    : fetch(new URL('../assets/cities/01.json', import.meta.url))
        .then((response) => (response.ok ? (response.json() as Promise<CityJson>) : null))
        .catch(() => null)
).then((city) => start(canvas, city));
