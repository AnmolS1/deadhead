/**
 * @deadhead/server — the `ponderance-play` Worker.
 *
 * Scaffold only (D-01). The Worker entry, Durable Objects and D1 bindings
 * arrive in B-01. It has no public route of its own; the site reaches it
 * through the `PLAY` service binding.
 */
import { SIM_VERSION } from '@deadhead/sim';

export const SERVER_VERSION = 0;

export { SIM_VERSION };
