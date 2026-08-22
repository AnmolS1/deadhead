import { env, exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { HealthReport } from '../src/health.js';

/**
 * Integration tests against the real Worker, in the real runtime, with the real
 * bindings out of `wrangler.jsonc`.
 *
 * `exports.default.fetch()` is the current form. `SELF` from `cloudflare:test`
 * is deprecated in pool-workers 0.21 and most tutorials still show it.
 */
const worker = workerExports.default;

async function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`http://play.test${path}`));
}

describe('/health', () => {
  it('answers on the bare path', async () => {
    const response = await get('/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('answers identically through the site proxy prefix', async () => {
    const bare = (await (await get('/health')).json()) as HealthReport;
    const proxied = (await (await get('/play/api/health')).json()) as HealthReport;
    expect(proxied).toStrictEqual(bare);
  });

  it('reports every binding declared in wrangler.jsonc as resolved', async () => {
    const report = (await (await get('/health')).json()) as HealthReport;

    // The assertion that earns its keep: this fails if a binding is renamed in
    // wrangler.jsonc without being renamed in `health.ts`, or if a Durable
    // Object namespace is declared in `exports` but never bound.
    expect(report.bindings).toStrictEqual({
      DB: true,
      RATE_LIMIT: true,
      LOBBY: true,
      MATCH: true,
      MATCHMAKER: true,
    });
    expect(report.ok).toBe(true);
  });

  it('reports the sim version, because a sim bump invalidates replays', async () => {
    const report = (await (await get('/health')).json()) as HealthReport;
    expect(report.versions.sim).toBeTypeOf('number');
    expect(report.service).toBe('ponderance-play');
  });

  it('goes 503 when a binding is missing, so a monitor fails on status alone', async () => {
    const { health } = await import('../src/health.js');
    // Cast through `unknown`: the point is to simulate the deploy-time failure
    // the endpoint exists to catch, which the `Env` type is designed to forbid.
    const broken = { ...env, DB: undefined } as unknown as Env;

    const response = health(broken);
    expect(response.status).toBe(503);

    const report = (await response.json()) as HealthReport;
    expect(report.ok).toBe(false);
    expect(report.bindings.DB).toBe(false);
    expect(report.bindings.LOBBY).toBe(true);
  });

  it('rejects a write to a read-only endpoint', async () => {
    const response = await worker.fetch(new Request('http://play.test/health', { method: 'POST' }));
    expect(response.status).toBe(405);
  });
});

describe('unknown routes', () => {
  it('404s with the normalised path, not the raw one', async () => {
    const response = await get('/play/api/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ error: 'not_found', detail: '/nope' });
  });
});

describe('durable object namespaces', () => {
  // Every DO class named in the `exports` map has to be reachable through its
  // binding, or the namespace was never provisioned. A 501 is the *right*
  // answer here — it proves the class instantiated and ran.
  it.each([
    ['LOBBY', 'M-01'],
    ['MATCH', 'M-03'],
    ['MATCHMAKER', 'M-02'],
  ])('%s resolves to a live object that is a %s scaffold', async (binding, task) => {
    const namespace = env[binding as 'LOBBY' | 'MATCH' | 'MATCHMAKER'];
    const stub = namespace.get(namespace.idFromName('probe'));

    const response = await stub.fetch('http://do.test/');
    expect(response.status).toBe(501);

    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe('not_implemented');
    expect(body.detail).toContain(task);
  });
});
