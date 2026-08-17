/**
 * @deadhead/proto — the wire format, shared by client and server.
 *
 * Scaffold only (D-01). The real contents arrive in S-12 (input encoding),
 * W-01 (city format) and M-04 (net protocol).
 *
 * Hard rule from CLAUDE.md: this package never takes a runtime dependency.
 */

/** Bumped whenever an encoding changes shape. Every format here is versioned. */
export const PROTO_VERSION = 0;

export {
  CITY_FORMAT_VERSION,
  INPUT_FORMAT_VERSION,
  NET_FORMAT_VERSION,
  WORLD_FORMAT_VERSION,
} from './format.js';

export {
  INPUT_MASK,
  Input,
  MAX_INPUT_LOG_BYTES,
  MAX_INPUT_LOG_TICKS,
  decodeInputLog,
  encodeInputLog,
  hasInput,
  packInput,
} from './input.js';

export type { InputLog } from './input.js';
