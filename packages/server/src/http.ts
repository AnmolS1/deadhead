/**
 * `http.ts` — the small shared shape of every response this Worker sends.
 *
 * JSON only, with a machine-readable `error` code rather than prose, because
 * `B-07`'s done-when is *"oversized, malformed, stale, and rate-limited
 * submissions are all rejected with distinct errors"* — distinct means the
 * client can branch on it, not that the sentences differ.
 */

/** Every failure this Worker returns carries one of these. */
export interface ApiError {
  readonly error: string;
  readonly detail?: string;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // This Worker is reached only through the site's service binding, so a
  // browser never sees these headers directly. Set anyway: a response that
  // leaks through some future path should not be sniffable or cacheable.
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
} as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS } });
}

export function fail(status: number, error: string, detail?: string): Response {
  const body: ApiError = detail === undefined ? { error } : { error, detail };
  return json(body, status);
}

/**
 * A Durable Object that exists so its namespace can be provisioned, but whose
 * behaviour belongs to a later task. Names the task, so a stray 501 in a log
 * says what is missing rather than that something broke.
 */
export function notImplemented(who: string, task: string): Response {
  return fail(501, 'not_implemented', `${who} is a ${task} scaffold`);
}
