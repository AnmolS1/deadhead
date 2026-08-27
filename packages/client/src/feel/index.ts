/**
 * `feel/` — `C-08`, the feel pass.
 *
 * `policy.ts` decides; `../render/feel.ts` draws. The split matches `audio/`
 * and exists for the same reason: the decisions are arithmetic and get tested,
 * the drawing gets looked at.
 */
export {
  FeelTuning,
  ease,
  elapsedEmptyTicks,
  feelFor,
  foldInsets,
  foldProgress,
  foldStartTick,
  foldedAreaFraction,
  type Feel,
  type FeelState,
  type FoldInsets,
  type FoldProgress,
} from './policy.js';
