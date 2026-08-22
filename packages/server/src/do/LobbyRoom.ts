/**
 * `LobbyRoom` — one Durable Object per room code.
 *
 * Scaffold only (`B-01`). `M-01` builds this out: roster, ready-up, host
 * settings, the 3–12 cap, and the creation of the `MatchRoom` with a
 * `locationHint` derived from the connected players' `request.cf.colo`.
 *
 * **This one hibernates.** It must use the WebSocket Hibernation API
 * (`state.acceptWebSocket` / `webSocketMessage` / `webSocketClose`) rather than
 * `server.accept()`, so an idle lobby costs nothing. That is the opposite of
 * `MatchRoom`, and the difference is deliberate — see the note there.
 */
import { DurableObject } from 'cloudflare:workers';

import { notImplemented } from '../http.js';

export class LobbyRoom extends DurableObject<Env> {
  override fetch(): Response {
    return notImplemented('LobbyRoom', 'M-01');
  }
}
