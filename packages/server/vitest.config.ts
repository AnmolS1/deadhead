import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The server's tests run **inside `workerd`**, because the server *is* a
 * Worker. There is no second node-pool suite here, unlike `packages/sim`, which
 * runs its suite twice precisely because it must be byte-identical in both
 * engines. Nothing here has that requirement — and a node run has no
 * `cloudflare:workers` module, no bindings and no Durable Objects, so it would
 * be testing a different program.
 *
 * ⚠️ **`cloudflareTest()` as a plugin, not `cloudflarePool()` as `test.pool`.**
 * The two look interchangeable and are not. `cloudflareTest` internally sets
 * `poolRunner = cloudflarePool(options)` *and* registers the `resolveId` hook
 * that makes `cloudflare:test` resolvable. Configure the pool directly and
 * tests still run in `workerd` — but every import of `cloudflare:test` fails
 * with `Cannot find package`, which reads like a missing dependency rather than
 * a missing plugin. `packages/sim/vitest.workerd.config.ts` uses the pool form
 * and is fine only because nothing there imports `cloudflare:test`.
 *
 * `wrangler.configPath` is load-bearing: the pool reads the real
 * `wrangler.jsonc`, so the bindings the tests see are the bindings that get
 * deployed. Restating the binding list here is exactly the drift this project
 * keeps getting caught by.
 *
 * The migrations are read **here**, in Node, because the test isolate has no
 * filesystem. They cross into it as an ordinary binding and are applied by
 * `test/setup.ts`, so the schema under test is the schema that ships.
 */
const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // A fixed, obviously-fake signing secret. `buildAuth` REFUSES to
          // construct without one — see the note there — so the auth suite
          // cannot run at all if this is absent, which is the point. It is not
          // a secret in any real sense and must never resemble the deployed
          // one; the real value is set with `wrangler secret put`.
          BETTER_AUTH_SECRET: 'test-secret-not-used-anywhere-real-0000000000',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
