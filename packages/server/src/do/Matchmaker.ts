/**
 * `Matchmaker` — the ranked queue.
 *
 * Scaffold only (`B-01`). `M-02` builds this out: rating and region buckets, a
 * rating window that widens with wait time, filling a lobby at ≥3 and starting
 * at N-max or on a timeout, then handing off to a `LobbyRoom`.
 */
import { DurableObject } from 'cloudflare:workers';

import { notImplemented } from '../http.js';

export class Matchmaker extends DurableObject<Env> {
  override fetch(): Response {
    return notImplemented('Matchmaker', 'M-02');
  }
}
