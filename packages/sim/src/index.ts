/**
 * `@deadhead/sim` — the deterministic simulation core.
 *
 * This package runs byte-identically in three places: the browser (prediction),
 * a Durable Object (authority), and a Worker (replay validation). It is pure
 * ESM with zero runtime dependencies and no ambient globals.
 *
 * What that forbids, in short — no DOM, no `Date.now()`, no `Math.random()`, no
 * `Math.sin`/`cos`/`sqrt` (implementation-defined across engines; use the
 * fixed-point LUT from `S-03`), and no floating point anywhere in state.
 * CLAUDE.md hard invariant #1 is the full list; `npm run lint:sim-purity`
 * (`S-02`) enforces it. The `tsconfig` here omits `"DOM"` from `lib`, so the
 * browser globals do not typecheck at all.
 *
 * The only entry point is {@link step}.
 */

export { createWorld, step } from './step.js';

export type { Inputs, PackedInput, PlayerId, World } from './types.js';

export {
  FX_MAX_MAGNITUDE,
  FX_MAX_SQUARABLE,
  SIM_VERSION,
  TICK_HZ,
  TICK_INTERVAL_US,
  WORLD_HALF_EXTENT,
  WORLD_MAX,
  WORLD_MIN,
} from './constants.js';
