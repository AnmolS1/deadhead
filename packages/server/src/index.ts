/**
 * `@deadhead/server` — the `ponderance-play` Worker.
 *
 * This file is the **package** entry (what other workspaces import). The
 * **Worker** entry is `worker.ts`, which is what `wrangler.jsonc` points `main`
 * at. Keeping them apart means a test or tool can import a pure helper without
 * dragging in the `cloudflare:workers` module graph.
 */
import { SIM_VERSION } from '@deadhead/sim';

export { SERVER_VERSION } from './version.js';
export { API_PREFIX, routePath } from './routes.js';
export { json, fail, notImplemented, type ApiError } from './http.js';
export { health, type HealthReport } from './health.js';

export { SIM_VERSION };
