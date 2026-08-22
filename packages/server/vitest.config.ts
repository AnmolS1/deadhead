import { cloudflarePool } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The server's tests run **inside `workerd`**, because the server *is* a
 * Worker. There is no second node-pool suite here, unlike `packages/sim`, which
 * runs its suite twice precisely because it must be byte-identical in both
 * engines. Nothing in this package has that requirement — and a node-pool run
 * would have no `cloudflare:workers` module, no bindings and no Durable
 * Objects, so it would test a different program.
 *
 * `wrangler.configPath` is load-bearing: the pool reads the real
 * `wrangler.jsonc`, so the bindings the tests see are the bindings that get
 * deployed. Duplicating the binding list here is exactly the drift this project
 * keeps getting caught by.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: cloudflarePool({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  },
});
