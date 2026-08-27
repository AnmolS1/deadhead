/**
 * `POST /play/api/run/start` — `B-06`.
 *
 * Mints the token a run must be played under. See `token.ts` for why the client
 * signing anything would be theatre.
 *
 * **The request body cannot influence the seed.** It carries only the city hash,
 * because the server has to know which city the client is about to play in order
 * to pin it — and even that is committed to the token rather than trusted later.
 * Everything else is server-generated.
 */
import { type AuthSecrets, buildAuth } from '../auth/index.js';
import { fail, json } from '../http.js';
import { mintRunToken } from './token.js';

export async function runStart(request: Request, env: Env & AuthSecrets): Promise<Response> {
  // A run belongs to an account. Anonymous play can exist later, but it cannot
  // reach the leaderboard, so there is nothing to mint a token for.
  const session = await buildAuth(env).api.getSession({ headers: request.headers });
  if (!session?.user?.id) return fail(401, 'not_authenticated');

  let body: { cityHash?: unknown };
  try {
    body = (await request.json()) as { cityHash?: unknown };
  } catch {
    return fail(400, 'invalid_body');
  }

  const cityHash = body.cityHash;
  if (typeof cityHash !== 'number' || !Number.isInteger(cityHash)) {
    return fail(400, 'invalid_city_hash');
  }

  const { token, claims } = await mintRunToken(env, session.user.id, cityHash, Date.now());

  // The seed is RETURNED but was not accepted — the client needs it to build the
  // same world the validator will, and it is in the signed claims, so changing
  // it locally only guarantees the replay diverges.
  return json({ token, runId: claims.runId, seed: claims.seed, startedAt: claims.startedAt });
}
