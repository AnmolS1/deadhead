/**
 * Input types.
 *
 * The state shape itself lives in `world.ts` (`S-05`) — it is one flat
 * `Int32Array` with a versioned layout, so it is described by offset constants
 * rather than by a TypeScript interface.
 */

/**
 * A player's slot in the match, `0..MAX_PLAYERS-1`. Slot order is stable for the
 * lifetime of a run and is the tiebreak of last resort for simultaneous events
 * (`M-09`).
 */
export type PlayerId = number;

/**
 * One tick of input for one player, packed into a single byte.
 *
 * `S-12` defines the bit layout and owns encoding, decoding and the run-length
 * encoded log format. Until then this is an opaque byte: the sim carries it,
 * but nothing here interprets it.
 */
export type PackedInput = number;

/**
 * Inputs for every player, indexed by {@link PlayerId}, for the tick being
 * stepped. Dense — a player with no input this tick gets their last received
 * byte repeated by the caller, never a hole. `M-03` does that repetition
 * server-side; the sim does not know a packet was lost.
 */
export type Inputs = readonly PackedInput[];
