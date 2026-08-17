import { cloudflarePool } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The cross-engine half of determinism.
 *
 * Runs the **entire** sim suite a second time inside `workerd` — the same
 * runtime the Durable Object and the replay validator use — rather than a
 * hand-picked subset. The goldens are what matter here (`fx`'s pinned sin-table
 * hash, `rng`'s reference fixture, `world`'s hash trail), and running
 * everything means no future test opts out of cross-engine coverage by
 * accident.
 *
 * This satisfies `S-06`'s "identical in two engines" clause and is the harness
 * `S-14` builds on.
 *
 * Note the API: `@cloudflare/vitest-pool-workers` 0.21 dropped the
 * `./config` subpath and `defineWorkersConfig`. The pool is now a value passed
 * to `test.pool`. Most tutorials still show the old form.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: cloudflarePool({
      miniflare: {
        compatibilityDate: '2026-08-01',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  },
});
