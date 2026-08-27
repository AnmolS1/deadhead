/**
 * `LobbyRoom` — one Durable Object per room code.
 *
 * Scaffold only (`B-01`), plus the `B-04` echo fixture below. `M-01` builds
 * this out: roster, ready-up, host settings, the 3–12 cap, and the creation of
 * the `MatchRoom` with a `locationHint` derived from the connected players'
 * `request.cf.colo`.
 *
 * **This one hibernates.** It must use the WebSocket Hibernation API
 * (`state.acceptWebSocket` / `webSocketMessage` / `webSocketClose`) rather than
 * `server.accept()`, so an idle lobby costs nothing. That is the opposite of
 * `MatchRoom`, and the difference is deliberate — see the note there.
 */
import { DurableObject } from 'cloudflare:workers';

import { notImplemented } from '../http.js';

export class LobbyRoom extends DurableObject<Env> {
  /**
   * `B-04` fixture: a WebSocket echo.
   *
   * **This exists to prove the proxy, not to be a feature.** `B-04`'s done-when
   * is *"reaches the DO and echoes"* — and "reaches the DO" is the load-bearing
   * half. Terminating the upgrade in `worker.ts` would pass a test that proves
   * strictly less than the claim: it would show the site forwards an `Upgrade`
   * to the play Worker, while saying nothing about whether a DO stub can carry
   * one. Those are separate hops and only the second is novel.
   *
   * It is written against the **hibernation** API on purpose, so `M-01`
   * inherits a working accept path rather than replacing a `server.accept()`
   * one. Delete the echo in `webSocketMessage`; keep the shape.
   */
  override fetch(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return notImplemented('LobbyRoom', 'M-01');
    }

    const { 0: client, 1: server } = new WebSocketPair();

    // `acceptWebSocket`, NOT `server.accept()`. The latter pins this object in
    // memory for the life of the socket, which is exactly the cost an idle
    // lobby must not pay.
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Hibernation handler. `M-01` replaces the echo with the lobby protocol. */
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    ws.send(typeof message === 'string' ? `echo:${message}` : message);
  }

  /**
   * Hibernation handler. The peer's code and reason are echoed back so a client
   * can tell a clean close from the 1006 an abrupt drop produces.
   *
   * **1005 must not be forwarded.** It is the "no status received" sentinel and
   * is not a legal code to *send*; passing it to `close()` throws.
   */
  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    ws.close(code === 1005 ? 1000 : code, reason);
  }
}
