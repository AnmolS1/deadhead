import { env, exports as workerExports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { AUTH_BASE_PATH } from '../src/auth/index.js';

/**
 * `B-03`. The done-when is *"signup, login, logout, and session refresh all
 * work through the same-origin proxy, with cookies visible on `ponderance.dev`
 * and nowhere else."*
 *
 * The second half is the part with no other guard on it. `headers.sh` in the
 * site repo fails the build if `Domain=` appears in `_headers` — but that gate
 * reads a **static file**, and Better Auth emits `Set-Cookie` at **runtime**,
 * where nothing looks. So these tests are the only thing standing between a
 * host-only session cookie and one scoped to `.ponderance.dev`, which every
 * future subdomain would receive.
 */
const worker = workerExports.default;

const ORIGIN = 'https://ponderance.dev';

function authUrl(path: string, base = AUTH_BASE_PATH): string {
  return `${ORIGIN}${base}${path}`;
}

async function post(url: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: ORIGIN,
  };
  if (cookie) headers['cookie'] = cookie;
  return worker.fetch(new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }));
}

/** Turn a `Set-Cookie` value into the cookie header a browser would send back. */
function toCookieHeader(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

let seq = 0;
function freshUser() {
  seq += 1;
  return {
    email: `player${seq}@example.test`,
    password: 'correct-horse-battery-staple',
    name: `Player ${seq}`,
  };
}

describe('signup', () => {
  it('creates an account and returns a session cookie', async () => {
    const user = freshUser();
    const response = await post(authUrl('/sign-up/email'), user);

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeTruthy();
  });

  it('writes the user into D1, not just into a response', async () => {
    const user = freshUser();
    await post(authUrl('/sign-up/email'), user);

    // Reads the real table through the real binding. A signup that only
    // produced a cookie would pass every assertion above this one.
    const row = await env.DB.prepare('SELECT email, name FROM user WHERE email = ?')
      .bind(user.email)
      .first<{ email: string; name: string }>();

    expect(row).not.toBeNull();
    expect(row?.name).toBe(user.name);
  });

  it('stores a credential in `account`, so the password can be checked later', async () => {
    const user = freshUser();
    await post(authUrl('/sign-up/email'), user);

    const row = await env.DB.prepare(
      'SELECT a.providerId, a.password FROM account a JOIN user u ON u.id = a.userId WHERE u.email = ?',
    )
      .bind(user.email)
      .first<{ providerId: string; password: string | null }>();

    // D1 has no interactive transactions, so `user` and `account` are written
    // by two separate statements. This asserts the second one actually
    // happened — the failure mode it guards is an account that exists and can
    // never log in.
    expect(row?.providerId).toBe('credential');
    expect(row?.password).toBeTruthy();
    expect(row?.password).not.toBe(user.password);
  });

  it('rejects a duplicate email', async () => {
    const user = freshUser();
    expect((await post(authUrl('/sign-up/email'), user)).status).toBe(200);
    expect((await post(authUrl('/sign-up/email'), user)).status).not.toBe(200);
  });
});

describe('the session cookie', () => {
  it('is host-only, Secure, HttpOnly and SameSite=Lax', async () => {
    const response = await post(authUrl('/sign-up/email'), freshUser());
    const setCookie = response.headers.get('set-cookie') ?? '';

    // THE assertion of this file. `Domain=` here would scope the session to
    // `.ponderance.dev` and hand it to every future subdomain. Nothing else in
    // either repo can see this header.
    expect(setCookie.toLowerCase()).not.toContain('domain=');

    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
  });
});

describe('login', () => {
  it('accepts the right password and issues a session', async () => {
    const user = freshUser();
    await post(authUrl('/sign-up/email'), user);

    const response = await post(authUrl('/sign-in/email'), {
      email: user.email,
      password: user.password,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeTruthy();
  });

  it('rejects the wrong password', async () => {
    const user = freshUser();
    await post(authUrl('/sign-up/email'), user);

    const response = await post(authUrl('/sign-in/email'), {
      email: user.email,
      password: 'not-the-password',
    });

    expect(response.status).not.toBe(200);
  });

  it('rejects an unknown email', async () => {
    const response = await post(authUrl('/sign-in/email'), {
      email: 'nobody@example.test',
      password: 'whatever',
    });
    expect(response.status).not.toBe(200);
  });
});

describe('session refresh and logout', () => {
  async function signedIn(): Promise<string> {
    const response = await post(authUrl('/sign-up/email'), freshUser());
    return toCookieHeader(response.headers.get('set-cookie') ?? '');
  }

  it('returns the session for a valid cookie', async () => {
    const cookie = await signedIn();
    const response = await worker.fetch(
      new Request(authUrl('/get-session'), { headers: { cookie, origin: ORIGIN } }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user?: { email?: string } } | null;
    expect(body?.user?.email).toBeTruthy();
  });

  it('returns no session without a cookie', async () => {
    const response = await worker.fetch(
      new Request(authUrl('/get-session'), { headers: { origin: ORIGIN } }),
    );
    const body = (await response.json()) as unknown;
    expect(body === null || (body as { user?: unknown }).user == null).toBe(true);
  });

  it('logout invalidates the session server-side, not just in the browser', async () => {
    const cookie = await signedIn();
    expect((await post(authUrl('/sign-out'), {}, cookie)).status).toBe(200);

    // Replay the SAME cookie. If logout only cleared it client-side, this still
    // returns a user — which is the whole difference between a logout and a
    // cosmetic one.
    const after = await worker.fetch(
      new Request(authUrl('/get-session'), { headers: { cookie, origin: ORIGIN } }),
    );
    const body = (await after.json()) as unknown;
    expect(body === null || (body as { user?: unknown }).user == null).toBe(true);
  });
});

describe('route canonicalisation', () => {
  it('serves auth on the bare path too, for a headless `wrangler dev`', async () => {
    // `worker.ts` rewrites `/auth/...` UP to `/play/api/auth/...` so Better
    // Auth sees one shape. Without that rewrite this 404s, and the game's own
    // bot clients (M-14) and any local curl would have to know the site prefix.
    const response = await post(authUrl('/sign-up/email', '/auth'), freshUser());
    expect(response.status).toBe(200);
  });

  it('does not answer auth routes that were never mounted', async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/play/api/auth-adjacent`));
    expect(response.status).toBe(404);
  });
});

describe('what B-03 deliberately does not enable', () => {
  it('has no GitHub provider configured without credentials', async () => {
    // GitHub OAuth is wired but inert until the two secrets exist — see the
    // note in `options.ts`. A provider configured with `undefined` credentials
    // fails at the redirect, which looks like a GitHub outage rather than a
    // missing secret, so it is left out entirely instead.
    const response = await post(authUrl('/sign-in/social'), { provider: 'github' });
    expect(response.status).not.toBe(200);
  });
});
