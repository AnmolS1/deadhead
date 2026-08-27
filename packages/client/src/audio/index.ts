/**
 * `audio/` — `C-07`.
 *
 * `policy.ts` holds every decision as pure arithmetic over sim state and is
 * tested; `engine.ts` turns that into Web Audio nodes and is verified by ear.
 * The split is deliberate — Web Audio exists in neither node nor `workerd`, so
 * anything expressed as node wiring cannot be regression-tested here.
 */
export { AudioEngine } from './engine.js';
export {
  AudioTuning,
  SIM_HZ,
  bankFraction,
  clockHz,
  clockPeriodSeconds,
  engineHz,
  loadMuted,
  mixFor,
  saveMuted,
  type AudioState,
  type Mix,
} from './policy.js';
