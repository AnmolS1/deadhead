/**
 * `routes.ts` — path normalisation, kept separate because it is the one part of
 * the request path with a decision in it.
 *
 * **The prefix is the whole problem.** `B-04` proxies the site's
 * `/play/api/[...path]` route to this Worker by forwarding the *original*
 * `Request` — it must, or the WebSocket `Upgrade` header is lost — so the path
 * that arrives in production is `/play/api/health`, not `/health`. But `B-01`'s
 * own verify is `curl localhost:8787/health` against `wrangler dev`, with no
 * site in front of it, and `M-14`'s bot clients will connect the same way.
 *
 * So both spellings have to work, and the Worker must not care which one it
 * got. Stripping a known prefix is a two-line function; discovering later that
 * every route is doubly-written is not.
 */

/**
 * The path the site mounts this Worker at. Must match the Astro route added in
 * `B-04` (`src/pages/play/api/[...path].ts`).
 */
export const API_PREFIX = '/play/api';

/**
 * The route path, with the proxy prefix removed if it is present.
 *
 * Always starts with `/`. Any trailing slash is dropped, so `/health/` and
 * `/health` are the same route — except for the root, which stays `/`.
 */
export function routePath(url: string | URL): string {
  const pathname = (typeof url === 'string' ? new URL(url) : url).pathname;

  let path = pathname;
  if (path === API_PREFIX) {
    path = '/';
  } else if (path.startsWith(`${API_PREFIX}/`)) {
    path = path.slice(API_PREFIX.length);
  }

  // Collapse a trailing slash, but never turn `/` into the empty string.
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return path === '' ? '/' : path;
}
