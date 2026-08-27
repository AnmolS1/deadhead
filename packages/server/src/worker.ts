/**
 * The `ponderance-play` Worker entry.
 *
 * Reached only through the site's `PLAY` service binding — this Worker declares
 * no route of its own. See `CLAUDE.md` → Architecture for why a service binding
 * rather than `script_name`: a `script_name` binding makes `wrangler dev` write
 * to **production** Durable Object storage, which is a documented foot-gun and
 * the reason this Worker exists as its own deploy unit at all.
 *
 * **The Durable Object classes must be re-exported from this file.** Wrangler
 * looks for each class named in `exports` on the module `main` points at; a
 * class that is only exported from `index.ts` is invisible to it and the deploy
 * fails at validation.
 */
import { AUTH_BASE_PATH, type AuthSecrets, buildAuth } from './auth/index.js';
import { LobbyRoom } from './do/LobbyRoom.js';
import { Matchmaker } from './do/Matchmaker.js';
import { MatchRoom } from './do/MatchRoom.js';
import { health } from './health.js';
import { runStart } from './runs/start.js';
import { fail } from './http.js';
import { routePath } from './routes.js';

export { LobbyRoom, MatchRoom, Matchmaker };

export default {
  fetch(request: Request, env: Env) {
    const path = routePath(request.url);

    if (path === '/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return fail(405, 'method_not_allowed');
      }
      return health(env);
    }

    // `B-04` fixture. The one route that proves the whole pipe: browser →
    // site Worker → service binding → play Worker → Durable Object, with the
    // `Upgrade` header surviving every hop. `M-01` replaces this with
    // `/lobby/:code` and the echo goes with it.
    //
    // **The original `request` is forwarded, not rebuilt.** A reconstructed
    // Request drops `Upgrade: websocket` and workerd then rejects the DO's 101
    // with `TypeError: Worker tried to return a WebSocket in a response to a
    // request which did not contain the header "Upgrade: websocket"`. Same rule
    // as the site's proxy route, for the same reason, one hop further in.
    if (path === '/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return fail(426, 'upgrade_required');
      }
      return env.LOBBY.get(env.LOBBY.idFromName('b04-echo')).fetch(request);
    }

    // Better Auth owns everything under `/auth`. `B-03`.
    //
    // **The URL is canonicalised UP, not stripped down.** Better Auth matches
    // against the full URL path, so it needs exactly one shape — but requests
    // arrive in two: `/play/api/auth/...` through the site, and `/auth/...`
    // against a bare `wrangler dev` or a test. `AUTH_BASE_PATH` is the proxied
    // spelling, so the bare form is rewritten to match it rather than the other
    // way round; that keeps the production URL the canonical one and leaves
    // OAuth callback URLs (which are absolute, and registered with GitHub)
    // identical in both.
    //
    // Rebuilding the Request is safe HERE and nowhere near `/ws`: this path
    // carries no `Upgrade` header, and `new Request(url, request)` preserves
    // method, headers — cookies included — and body.
    if (path === '/auth' || path.startsWith('/auth/')) {
      const url = new URL(request.url);
      if (url.pathname !== `${AUTH_BASE_PATH}${path.slice('/auth'.length)}`) {
        url.pathname = `${AUTH_BASE_PATH}${path.slice('/auth'.length)}`;
        request = new Request(url, request);
      }
      return buildAuth(env as Env & AuthSecrets).handler(request);
    }

    // `B-06`. Mints the token a run must be played under. `B-07` adds
    // `/run/submit`, which redeems it — and takes an input log, never a score.
    if (path === '/run/start') {
      if (request.method !== 'POST') return fail(405, 'method_not_allowed');
      return runStart(request, env as Env & AuthSecrets);
    }

    return fail(404, 'not_found', path);
  },
} satisfies ExportedHandler<Env>;
