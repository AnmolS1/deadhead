/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Test-only types.
 *
 * The triple-slash reference above is what makes `cloudflare:test` resolvable
 * to `tsc`. It is separate from the Vite plugin that makes it resolvable at
 * *runtime* (see `vitest.config.ts`) and you need both — vitest transpiles
 * tests without typechecking them, so a suite can be entirely green while
 * `npm run typecheck` fails on the same file. A `types` entry in
 * `tsconfig.test.json` would work too, but it replaces the default `@types`
 * discovery rather than adding to it.
 *
 * The `Cloudflare.Env` augmentation below adds a binding that exists **only**
 * in the test harness. Deliberately not the global `Env` the Worker sees: the
 * production type must not grow a field that is `undefined` at runtime.
 */
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    BETTER_AUTH_SECRET: string;
  }
}
