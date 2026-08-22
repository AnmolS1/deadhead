/**
 * `MatchRoom` — one Durable Object per live match, ticking at 30 Hz.
 *
 * Scaffold only (`B-01`). `M-03` onward builds this out: the authoritative sim,
 * input intake, snapshot broadcast, and the 20 Hz send rate.
 *
 * **This one does *not* hibernate, on purpose.** It runs a `setInterval` tick,
 * which pins the object in memory. A match is ~8 minutes of billed wall-clock
 * and that is both correct and cheap — the free 13,000 GB-s/day is roughly 29
 * DO-hours. Do not "optimise" this into an alarm: DO alarms are not sub-second
 * reliable, and the tick is the one thing in this system that must be.
 */
import { DurableObject } from 'cloudflare:workers';

import { notImplemented } from '../http.js';

export class MatchRoom extends DurableObject<Env> {
  override fetch(): Response {
    return notImplemented('MatchRoom', 'M-03');
  }
}
