/**
 * `/health` — the endpoint `B-01`'s done-when asks for.
 *
 * It reports **which bindings actually resolved**, not a hardcoded `ok: true`.
 * A health check that cannot fail is decoration. The failure this one is built
 * to catch is the one that will actually happen: `B-04` wires the service
 * binding, a binding name is mistyped or a namespace was never provisioned, and
 * every request 500s somewhere deep with no clue which of the six it was.
 *
 * Booleans only. Never echo a binding's contents, an id, or a secret — this
 * response is reachable through the public site once `B-04` lands.
 */
import { SIM_VERSION } from '@deadhead/sim';

import { json } from './http.js';
import { SERVER_VERSION } from './version.js';

export interface HealthReport {
  readonly ok: boolean;
  readonly service: 'ponderance-play';
  readonly versions: { readonly sim: number; readonly server: number };
  /** Binding name → whether it resolved. All must be true for `ok`. */
  readonly bindings: Readonly<Record<string, boolean>>;
}

export function health(env: Env): Response {
  const bindings = {
    DB: env.DB !== undefined,
    RATE_LIMIT: env.RATE_LIMIT !== undefined,
    LOBBY: env.LOBBY !== undefined,
    MATCH: env.MATCH !== undefined,
    MATCHMAKER: env.MATCHMAKER !== undefined,
  };

  const ok = Object.values(bindings).every(Boolean);
  const report: HealthReport = {
    ok,
    service: 'ponderance-play',
    versions: { sim: SIM_VERSION, server: SERVER_VERSION },
    bindings,
  };

  // 503 on a missing binding, so a monitor or a deploy check fails on status
  // alone without parsing the body.
  return json(report, ok ? 200 : 503);
}
