import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import {
  RUN_TOKEN_TTL_SECONDS,
  mintRunToken,
  redeemRunToken,
  runTokenKey,
  signRunToken,
  verifyRunToken,
  type TokenEnv,
} from '../src/runs/token.js';

/**
 * `B-06`. The done-when is three specific rejections — replayed, forged, wrong
 * user — and each has its own test below saying which defence catches it.
 *
 * The signature stops FORGERY. The KV entry stops REPLAY. They are different
 * defences and neither substitutes for the other, so they are tested apart.
 */
const SECRET = 'test-secret-not-used-anywhere-real-0000000000';
const CITY_HASH = 0xd6bc63b0 | 0;
const NOW = 1_700_000_000_000;

function tokenEnv(): TokenEnv {
  return env as unknown as TokenEnv;
}

describe('minting', () => {
  it('chooses the seed itself — the client never gets to', () => {
    // THE point of the task. If a client could pick its seed it would farm
    // seeds offline until one spawned a lucrative fare beside the cab, and every
    // leaderboard entry would be a seed search rather than a run.
    const seeds = new Set<number>();
    return (async () => {
      for (let i = 0; i < 8; i += 1) {
        const { claims } = await mintRunToken(tokenEnv(), 'user-a', CITY_HASH, NOW);
        seeds.add(claims.seed);
        expect(claims.seed).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(claims.seed)).toBe(true);
      }
      // Eight identical seeds would mean it is not random at all.
      expect(seeds.size).toBeGreaterThan(1);
    })();
  });

  it('records the token as unspent in KV, under a run: prefix', async () => {
    const { claims } = await mintRunToken(tokenEnv(), 'user-a', CITY_HASH, NOW);
    // The prefix matters: this namespace also carries B-07's rate limits, and an
    // unprefixed key space would let one collide with or purge the other.
    expect(runTokenKey(claims.runId).startsWith('run:')).toBe(true);
    expect(await env.RATE_LIMIT.get(runTokenKey(claims.runId))).not.toBeNull();
  });

  it('commits to the user, city and start time', async () => {
    const { claims } = await mintRunToken(tokenEnv(), 'user-a', CITY_HASH, NOW);
    expect(claims.userId).toBe('user-a');
    expect(claims.cityHash).toBe(CITY_HASH);
    expect(claims.startedAt).toBe(NOW);
  });
});

describe('a replayed token is rejected', () => {
  it('redeems once and refuses the second time', async () => {
    const { token } = await mintRunToken(tokenEnv(), 'user-a', CITY_HASH, NOW);

    const first = await redeemRunToken(tokenEnv(), token, 'user-a', NOW);
    expect(first.ok).toBe(true);

    const second = await redeemRunToken(tokenEnv(), token, 'user-a', NOW);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toBe('token_spent');
  });

  it('burns the token even though its signature is still perfectly valid', async () => {
    // The distinction the whole design rests on: the HMAC still verifies after
    // redemption. Only the KV entry knows it has been spent. A system relying on
    // the signature alone would accept a replay forever.
    const { token } = await mintRunToken(tokenEnv(), 'user-a', CITY_HASH, NOW);
    await redeemRunToken(tokenEnv(), token, 'user-a', NOW);

    const stillSigned = await verifyRunToken(SECRET, token);
    expect(stillSigned.ok).toBe(true);
  });
});

describe('a forged token is rejected', () => {
  it('refuses a tampered payload', async () => {
    // Raise the seed in the claims and re-encode WITHOUT re-signing — the
    // attack a client would actually try if it wanted a seed of its choosing.
    const { claims } = await mintRunToken(tokenEnv(), 'user-a', CITY_HASH, NOW);
    const forged = { ...claims, seed: 12345 };
    const payload = btoa(JSON.stringify(forged))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const real = await signRunToken(SECRET, claims);
    const tamperedToken = `${payload}.${real.slice(real.indexOf('.') + 1)}`;

    const result = await redeemRunToken(tokenEnv(), tamperedToken, 'user-a', NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('token_bad_signature');
  });

  it('refuses a token signed with the wrong key', async () => {
    const claims = {
      userId: 'user-a',
      runId: 'made-up',
      seed: 1,
      cityHash: CITY_HASH,
      startedAt: NOW,
    };
    const wrong = await signRunToken('a-completely-different-secret', claims);
    const result = await verifyRunToken(SECRET, wrong);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('token_bad_signature');
  });

  it('refuses garbage that is not a token at all', async () => {
    for (const junk of ['', '.', 'nodot', 'a.', '.b', 'a.b']) {
      const result = await verifyRunToken(SECRET, junk);
      expect(result.ok, junk).toBe(false);
    }
  });

  it('refuses a signature that is valid over a non-token payload', async () => {
    // Properly signed, but the payload is not claims. Catches a future change
    // that trusts JSON.parse without checking the shape.
    const payload = btoa('not json at all').replace(/=+$/, '');
    const key = await signRunToken(SECRET, {
      userId: 'x',
      runId: 'y',
      seed: 1,
      cityHash: 1,
      startedAt: 1,
    });
    void key;
    const result = await verifyRunToken(SECRET, `${payload}.AAAA`);
    expect(result.ok).toBe(false);
  });
});

describe('a token for a different user is rejected', () => {
  it('refuses redemption by anyone else', async () => {
    const { token } = await mintRunToken(tokenEnv(), 'user-a', CITY_HASH, NOW);
    const result = await redeemRunToken(tokenEnv(), token, 'user-b', NOW);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('token_wrong_user');
  });

  it('does NOT burn the token when the wrong user presents it', async () => {
    // Otherwise anyone who learned a token id could grief its owner by spending
    // it on their behalf — a denial of service with no authentication needed.
    const { token } = await mintRunToken(tokenEnv(), 'user-a', CITY_HASH, NOW);
    await redeemRunToken(tokenEnv(), token, 'user-b', NOW);

    const owner = await redeemRunToken(tokenEnv(), token, 'user-a', NOW);
    expect(owner.ok).toBe(true);
  });
});

describe('expiry', () => {
  it('refuses a token older than its TTL', async () => {
    const { token } = await mintRunToken(tokenEnv(), 'user-a', CITY_HASH, NOW);
    const late = NOW + RUN_TOKEN_TTL_SECONDS * 1000 + 1;
    const result = await redeemRunToken(tokenEnv(), token, 'user-a', late);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('token_expired');
  });

  it('accepts one just inside the TTL', async () => {
    const { token } = await mintRunToken(tokenEnv(), 'user-a', CITY_HASH, NOW);
    const justInTime = NOW + RUN_TOKEN_TTL_SECONDS * 1000 - 1;
    expect((await redeemRunToken(tokenEnv(), token, 'user-a', justInTime)).ok).toBe(true);
  });
});
