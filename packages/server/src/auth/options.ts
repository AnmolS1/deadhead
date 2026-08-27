/**
 * `auth/options.ts` — the Better Auth configuration, minus the database.
 *
 * **Why the database is not in here.** Two callers need this config and only
 * one of them has a D1 binding:
 *
 *  1. the Worker, which builds a real instance per request (`./index.ts`);
 *  2. the schema generator (`scripts/gen-auth-schema.mjs`), which runs in
 *     **Node**, where `env.DB` does not exist and cannot.
 *
 * `TASKS.md` says `0002_auth.sql` is *generated*, not hand-written, and the
 * reason is drift: Better Auth derives its schema from the live config, so
 * enabling a plugin changes columns *and* tables. A hand-written migration is
 * correct exactly until someone edits this file. Splitting the options out is
 * what lets the generator read the same object the Worker runs, so the schema
 * cannot describe a different config from the one in production.
 */
import type { BetterAuthOptions } from 'better-auth';

import { API_PREFIX } from '../routes.js';

/**
 * Secrets, which are **not** in the generated `Env`.
 *
 * `wrangler types` only knows about bindings declared in `wrangler.jsonc`;
 * anything set with `wrangler secret put` is invisible to it. Declaring them
 * here keeps the cast in `index.ts` honest about what it is asserting.
 */
export interface AuthSecrets {
  /** Signs session cookies and tokens. `wrangler secret put BETTER_AUTH_SECRET`. */
  readonly BETTER_AUTH_SECRET?: string | undefined;
  readonly GITHUB_CLIENT_ID?: string | undefined;
  readonly GITHUB_CLIENT_SECRET?: string | undefined;
}

/**
 * Where the auth routes live, as Better Auth sees them.
 *
 * **This is the proxied spelling on purpose.** Better Auth matches against the
 * full URL path, so it needs one stable shape — but requests arrive in two:
 * `/play/api/auth/...` through the site (`B-04`), and `/auth/...` against a
 * bare `wrangler dev`. `worker.ts` canonicalises the bare form *up* to this one
 * rather than stripping this one down, so there is a single `basePath` and both
 * entry points work. Same reasoning as `routePath()`, one layer further in.
 */
export const AUTH_BASE_PATH = `${API_PREFIX}/auth`;

/**
 * Build the shared options.
 *
 * `secrets` is optional because the generator has none and does not need any —
 * the schema depends on which providers are *enabled*, not on their credentials.
 * To keep the generated schema stable regardless of whether GitHub credentials
 * happen to be present, provider configuration must never add or remove fields.
 * It does not: Better Auth's `account` table is provider-agnostic.
 */
export function authOptions(secrets: AuthSecrets = {}): BetterAuthOptions {
  const github =
    secrets.GITHUB_CLIENT_ID && secrets.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: secrets.GITHUB_CLIENT_ID,
            clientSecret: secrets.GITHUB_CLIENT_SECRET,
          },
        }
      : {};

  return {
    appName: 'Creaseway',
    basePath: AUTH_BASE_PATH,

    // Absent in the generator, and required at runtime — `index.ts` refuses to
    // build without it rather than letting Better Auth invent a dev default and
    // sign real sessions with a key that changes on every deploy.
    ...(secrets.BETTER_AUTH_SECRET ? { secret: secrets.BETTER_AUTH_SECRET } : {}),

    emailAndPassword: {
      enabled: true,
      // No mail sender exists yet. Turning verification on without one would
      // create accounts that can never log in. `B-11` or a later task owns it.
      requireEmailVerification: false,
    },

    // Only present when the credentials are. An OAuth provider configured with
    // `undefined` secrets fails at the redirect, which looks like a provider
    // outage rather than a missing secret.
    socialProviders: github,

    user: {
      // `DESIGN.md` wants a display name that is changeable and moderated
      // (`B-11`) and therefore NOT the account identity. Better Auth's `name`
      // is the identity-ish field it fills from the OAuth profile; the game's
      // display name lives in `players.display_name` (`B-02`), keyed by
      // `players.id` = the auth user id. That is the only coupling point
      // between the two schemas, and it is deliberate.
      changeEmail: { enabled: false },
    },

    advanced: {
      // **Host-only cookies.** `headers.sh` in the site repo fails the build if
      // `Domain=` appears in `_headers` — but that gate reads a static file and
      // never sees a `Set-Cookie` the Worker emits at runtime. So nothing but a
      // test protects this. There is one, and it asserts on the real header.
      //
      // `crossSubDomainCookies` is off by default; it is named here so that
      // turning it on is a deliberate act with this comment attached, not an
      // autocomplete accident. Turning it on would scope cookies to
      // `.ponderance.dev` and hand every future subdomain the session.
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      },
    },
  };
}
