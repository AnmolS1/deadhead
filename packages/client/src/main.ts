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
import {
  Car,
  FX_ONE,
  createWorld,
  emptyCity,
  getCar,
  getTick,
  step,
  type World,
} from '@deadhead/sim';

import { getContext, resizeCanvas, type Viewport } from './canvas.js';
import {
  InputBuffer,
  attachKeyboard,
  attachTouch,
  loadBindings,
  pollGamepad,
} from './input/index.js';
import { FixedTimestepLoop } from './loop.js';

/** Everything a running game needs. `G-01` gives this a real lifecycle. */
interface Session {
  /** State at the end of the last completed tick. */
  current: World;
  /** State one tick earlier, for `C-05` to interpolate against. */
  previous: World;
  readonly loop: FixedTimestepLoop;
  readonly input: InputBuffer;
}

function start(canvas: HTMLCanvasElement): void {
  const context = getContext(canvas);
  let viewport: Viewport = resizeCanvas(canvas) ?? {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: 1,
  };

  // An empty city until `W-03` — the loop is what this task is about.
  const world = createWorld(1, 1, emptyCity());
  const session: Session = {
    current: world,
    previous: world,
    loop: new FixedTimestepLoop(),
    input: new InputBuffer(),
  };

  attachKeyboard(window, session.input, loadBindings(safeLocalStorage()));
  attachTouch(canvas, session.input, () => ({ width: viewport.width, height: viewport.height }));

  const inputs = [0];

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

    render(context, viewport, session, alpha);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

/** Placeholder. `C-04` owns the real one; this proves the loop is turning. */
function render(
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  session: Session,
  alpha: number,
): void {
  context.fillStyle = '#111';
  context.fillRect(0, 0, viewport.width, viewport.height);

  const x = getCar(session.current, 0, Car.X) / FX_ONE;
  const y = getCar(session.current, 0, Car.Y) / FX_ONE;

  context.fillStyle = '#f5f5f5';
  context.font = `${14 * viewport.pixelRatio}px ui-monospace, monospace`;
  context.fillText(
    `tick ${getTick(session.current)}  alpha ${alpha.toFixed(3)}  cab ${x.toFixed(1)}, ${y.toFixed(1)}`,
    16 * viewport.pixelRatio,
    28 * viewport.pixelRatio,
  );
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
start(canvas);
