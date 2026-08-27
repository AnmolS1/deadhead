/**
 * `runs/token.ts` — `B-06`. The run token.
 *
 * ## Why this exists, and why the obvious version is theatre
 *
 * The tempting design is: the client computes its score, HMACs it, and the
 * server checks the signature. **That is worthless.** The key would have to ship
 * in the bundle, so anyone can sign anything, and the signature proves only that
 * the attacker read the source. It is security pantomime — it looks like
 * cryptography and defends nothing.
 *
 * This is the opposite arrangement. **The server holds the key and the client
 * never signs anything.** The server mints a token *before* the run, committing
 * to the parameters the run must have been played under; the client plays, then
 * returns the token alongside its **input log** — never a score. `B-07` and
 * `B-08` re-simulate that log server-side and derive the score themselves.
 *
 * So the token does not certify a result. It certifies that *this user started
 * this run, with this seed, on this city, at this time* — which is the thing a
 * cheater would otherwise get to choose.
 *
 * ## What each claim stops
 *
 * - `seed` — **the client cannot choose it.** Otherwise a player farms seeds
 *   offline until they find one that spawns a lucrative fare next to the cab,
 *   and every leaderboard entry is a seed search rather than a run.
 * - `cityHash` — pins the city the run was played on. A replay validated against
 *   a different city diverges immediately (ADR 0005 folds the hash into the run
 *   seed), so this makes that a clean rejection rather than a mysterious one.
 * - `userId` — a token is bound to who it was minted for, so one account cannot
 *   hand another a token.
 * - `startedAt` — `B-07` uses it for the wall-clock plausibility check: a run
 *   cannot have taken less real time than the ticks in its log.
 * - `runId` — the KV key, and therefore what makes the token single-use.
 *
 * ## Signature and burn are different defences
 *
 * The HMAC stops *forgery*. The KV entry stops *replay*. Neither substitutes for
 * the other: a valid signature says the server minted this, and says nothing
 * about whether it has already been spent.
 */
import { type AuthSecrets } from '../auth/index.js';

/** Claims the server commits to when a run starts. */
export interface RunClaims {
  readonly userId: string;
  readonly runId: string;
  /** Server-chosen. Never accepted from the client. */
  readonly seed: number;
  readonly cityHash: number;
  /** Unix ms, server clock. */
  readonly startedAt: number;
}

/** How long a minted token stays spendable. */
export const RUN_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * KV key for a run token.
 *
 * **The `run:` prefix is load-bearing.** The `RATE_LIMIT` namespace serves two
 * purposes — `B-07`'s rate limits and these tokens — and an unprefixed key
 * space would let one collide with or purge the other. See the note in
 * `wrangler.jsonc`.
 */
export function runTokenKey(runId: string): string {
  return `run:${runId}`;
}

/** Everything that can go wrong, as codes a client can branch on. */
export type TokenFailure =
  'token_malformed' | 'token_bad_signature' | 'token_spent' | 'token_expired' | 'token_wrong_user';

export interface VerifyOk {
  readonly ok: true;
  readonly claims: RunClaims;
}
export interface VerifyErr {
  readonly ok: false;
  readonly error: TokenFailure;
}

const encoder = new TextEncoder();

/**
 * Derive the signing key from the auth secret.
 *
 * **Derived rather than a second secret to provision.** HKDF with a distinct
 * `info` string gives domain separation — a run token cannot be used as a
 * session cookie or vice versa, even though both trace back to one secret — and
 * it means there is no second `wrangler secret put` that someone can forget,
 * which would otherwise fail open at the worst moment.
 */
async function signingKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // Empty salt is fine and standard here: the input is already a
      // high-entropy secret, not a password.
      salt: new Uint8Array(0),
      info: encoder.encode('deadhead/run-token/v1'),
    },
    material,
    256,
  );
  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Sign claims into a `payload.signature` token. */
export async function signRunToken(secret: string, claims: RunClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const key = await signingKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Check a token's signature and shape. Does **not** check whether it is spent —
 * that needs KV and lives in {@link redeemRunToken}.
 *
 * Uses `crypto.subtle.verify` rather than comparing strings, so the comparison
 * is constant-time. A `===` on two base64 strings leaks the signature a byte at
 * a time to anyone willing to measure.
 */
export async function verifyRunToken(secret: string, token: string): Promise<VerifyOk | VerifyErr> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, error: 'token_malformed' };

  const payload = token.slice(0, dot);
  const signature = fromBase64Url(token.slice(dot + 1));
  if (signature === null) return { ok: false, error: 'token_malformed' };

  const key = await signingKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature as unknown as ArrayBuffer,
    encoder.encode(payload),
  );
  if (!valid) return { ok: false, error: 'token_bad_signature' };

  const raw = fromBase64Url(payload);
  if (raw === null) return { ok: false, error: 'token_malformed' };

  let claims: RunClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(raw)) as RunClaims;
  } catch {
    return { ok: false, error: 'token_malformed' };
  }

  // A signature over a well-formed envelope containing a garbage payload is
  // still garbage. Only a token this server minted can reach here, but a future
  // version of this file could mint a different shape.
  if (
    typeof claims.userId !== 'string' ||
    typeof claims.runId !== 'string' ||
    typeof claims.seed !== 'number' ||
    typeof claims.cityHash !== 'number' ||
    typeof claims.startedAt !== 'number'
  ) {
    return { ok: false, error: 'token_malformed' };
  }

  return { ok: true, claims };
}

/** The bindings this module needs. */
export interface TokenEnv extends AuthSecrets {
  readonly RATE_LIMIT: KVNamespace;
}

/**
 * Mint a token and record it as unspent.
 *
 * `seed` and `runId` are generated here, from `crypto.getRandomValues`, and are
 * never taken from the request — that is the whole point of the task.
 */
export async function mintRunToken(
  env: TokenEnv,
  userId: string,
  cityHash: number,
  now: number,
): Promise<{ token: string; claims: RunClaims }> {
  const secret = env.BETTER_AUTH_SECRET;
  if (secret === undefined) throw new Error('BETTER_AUTH_SECRET is not set');

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const runId = toBase64Url(bytes);

  const seedBytes = new Uint32Array(1);
  crypto.getRandomValues(seedBytes);
  // Positive int32: the sim's RNG takes a signed 32-bit seed and a negative one
  // is legal but makes logs and URLs uglier for no gain.
  const seed = (seedBytes[0] ?? 0) & 0x7fffffff;

  const claims: RunClaims = { userId, runId, seed, cityHash, startedAt: now };
  const token = await signRunToken(secret, claims);

  await env.RATE_LIMIT.put(runTokenKey(runId), '1', {
    expirationTtl: RUN_TOKEN_TTL_SECONDS,
  });

  return { token, claims };
}

/**
 * Verify a token and **burn it**, so it cannot be used twice.
 *
 * The delete happens before the caller does anything with the claims. A
 * validator that burned the token only on success would let a submission that
 * fails validation be retried forever with tweaked input — which is a free
 * oracle for finding the edge of the checks.
 */
export async function redeemRunToken(
  env: TokenEnv,
  token: string,
  expectedUserId: string,
  now: number,
): Promise<VerifyOk | VerifyErr> {
  const secret = env.BETTER_AUTH_SECRET;
  if (secret === undefined) throw new Error('BETTER_AUTH_SECRET is not set');

  const verified = await verifyRunToken(secret, token);
  if (!verified.ok) return verified;

  const { claims } = verified;

  // Bound to whoever it was minted for. Checked before the burn, so one account
  // cannot spend another's token even by presenting it.
  if (claims.userId !== expectedUserId) return { ok: false, error: 'token_wrong_user' };

  if (now - claims.startedAt > RUN_TOKEN_TTL_SECONDS * 1000) {
    return { ok: false, error: 'token_expired' };
  }

  const key = runTokenKey(claims.runId);
  const live = await env.RATE_LIMIT.get(key);
  if (live === null) return { ok: false, error: 'token_spent' };

  await env.RATE_LIMIT.delete(key);
  return { ok: true, claims };
}
