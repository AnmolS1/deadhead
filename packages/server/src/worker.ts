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
import { LobbyRoom } from './do/LobbyRoom.js';
import { Matchmaker } from './do/Matchmaker.js';
import { MatchRoom } from './do/MatchRoom.js';
import { health } from './health.js';
import { fail } from './http.js';
import { routePath } from './routes.js';

export { LobbyRoom, MatchRoom, Matchmaker };

export default {
  fetch(request, env) {
    const path = routePath(request.url);

    if (path === '/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return fail(405, 'method_not_allowed');
      }
      return health(env);
    }

    return fail(404, 'not_found', path);
  },
} satisfies ExportedHandler<Env>;
