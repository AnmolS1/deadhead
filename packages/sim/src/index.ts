/**
 * @deadhead/sim — the deterministic simulation core.
 *
 * Scaffold only (D-01). The real entry point — `step(world, inputs) -> world` —
 * arrives in S-01, on top of the fixed-point math from S-03.
 *
 * This package must run byte-identically in the browser, in a Durable Object
 * and in a replay-validating Worker. See CLAUDE.md hard invariant #1 for what
 * that forbids; `npm run lint:sim-purity` (S-02) enforces it.
 */
import { PROTO_VERSION } from '@deadhead/proto';

/** Bumped whenever the sim changes in a way that invalidates recorded replays. */
export const SIM_VERSION = 0;

export { PROTO_VERSION };
