/**
 * `auth/index.ts` — the runtime Better Auth instance.
 *
 * **Built per request, not once at module scope.** A Worker isolate is reused
 * across requests but `env` is handed in per invocation, and a D1 binding
 * captured into a module-level singleton belongs to whichever request happened
 * to be first. Better Auth is cheap to construct; a stale binding is not cheap
 * to debug.
 *
 * **D1 needs no adapter package.** Better Auth's Kysely adapter detects a
 * `D1Database` by duck-typing (`batch` + `exec` + `prepare`) and selects its own
 * `D1SqliteDialect` plus a D1 index introspector. So `database: env.DB` is the
 * whole integration — no `better-auth-cloudflare` (which would pull `drizzle-orm`,
 * `mime` and `zod` into the bundle) and no `kysely-d1` (unmaintained since
 * 2025-04). `TASKS.md`'s brief names the former; it predates this being built in.
 *
 * **Transactions do not exist here, by construction.** D1 has no interactive
 * transactions, so the dialect reports `transaction: false` and Better Auth's
 * base adapter patches the transaction wrapper into a pass-through — with a
 * console warning on every cold start, which is expected and not a bug. The real
 * consequence: a signup interrupted between the `user` and `account` inserts
 * leaves a user row with no credential, and retrying the signup hits the unique
 * email constraint. That is a real edge and it is **not** handled here; it needs
 * either a reconciliation pass or D1's `batch()`, and it belongs to a task that
 * can be tested for it rather than to a comment.
 */
import { betterAuth } from 'better-auth';

import { type AuthSecrets, authOptions } from './options.js';

export { AUTH_BASE_PATH } from './options.js';
export type { AuthSecrets } from './options.js';

/** Thrown when the signing secret is absent. See the note below. */
export class MissingAuthSecretError extends Error {
  constructor() {
    super('BETTER_AUTH_SECRET is not set; refusing to sign sessions with a generated key');
    this.name = 'MissingAuthSecretError';
  }
}

/**
 * Build an auth instance for one request.
 *
 * Throws if `BETTER_AUTH_SECRET` is missing. **That is deliberate and it is the
 * safer failure.** Better Auth will happily fall back to a generated secret,
 * which signs real session cookies with a key that changes whenever the isolate
 * is replaced — so every user is silently logged out at unpredictable intervals
 * and nothing in the logs says why. A loud 500 at the first auth request is a
 * better outcome than a login that works in testing and rots in production.
 */
// The return type is INFERRED, deliberately. `betterAuth()` is generic over the
// exact options object, and annotating it as `ReturnType<typeof betterAuth>`
// widens the options to `BetterAuthOptions` — where `database` is optional —
// which then fails to satisfy the instantiated type where it is required.
// The error is forty lines of nested `$context` mismatch that never mentions
// the annotation. Leave it off.
export function buildAuth(env: Env & AuthSecrets) {
  if (!env.BETTER_AUTH_SECRET) {
    throw new MissingAuthSecretError();
  }

  return betterAuth({
    ...authOptions(env),
    database: env.DB,
  });
}
