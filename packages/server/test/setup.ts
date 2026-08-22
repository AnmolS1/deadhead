import { applyD1Migrations, env } from 'cloudflare:test';

/**
 * Apply `migrations/` to the test database before anything runs.
 *
 * This is the same migration set `wrangler d1 migrations apply` runs against a
 * real D1 — read off disk by `vitest.config.ts` and handed in as a binding.
 * Testing against a schema written out a second time in the test harness would
 * only prove the harness agrees with itself.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
