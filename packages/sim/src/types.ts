/**
 * The state shape.
 *
 * Skeleton (`S-01`). `S-05` replaces `World`'s body with the real thing — cars,
 * passengers, NPC traffic, clocks, RNG state — as flat int-only structs, and
 * owns `serialize`/`deserialize`/`hashWorld`. The shape of the *contract* is
 * fixed here so `step()` has a signature the rest of Phase 1 can build against.
 *
 * Everything in this file is `int32` by construction. No floats reach world
 * state — see CLAUDE.md hard invariant #1.
 */

/**
 * A player's slot in the match, `0..N-1`. Slot order is stable for the lifetime
 * of a run and is the tiebreak of last resort for simultaneous events (`M-09`).
 */
export type PlayerId = number;

/**
 * One tick of input for one player, packed into a single byte.
 *
 * `S-12` defines the bit layout and owns encoding, decoding and the run-length
 * encoded log format. Until then this is an opaque byte: the sim reads it, but
 * nothing here interprets it.
 */
export type PackedInput = number;

/**
 * Inputs for every player, indexed by {@link PlayerId}, for the tick being
 * stepped. Dense — a player with no input this tick gets their last received
 * byte repeated by the caller, never a hole. `M-03` does that repetition
 * server-side; the sim does not know a packet was lost.
 */
export type Inputs = readonly PackedInput[];

/**
 * The complete simulation state at one instant.
 *
 * The whole of it is hashed by `S-05` and shipped to the replay validator, so
 * anything added here must be deterministic, integer, and serialisable. If a
 * value is derivable from other state, derive it — do not store it.
 */
export interface World {
  /**
   * Format version of this state's serialisation. Bumped by `S-05` whenever the
   * layout changes, so an old replay is rejected rather than silently
   * misinterpreted.
   */
  readonly version: number;

  /**
   * Ticks elapsed since the run began, starting at 0. Combined with the seed,
   * this is the entire input to NPC traffic (`S-08`) — which is why traffic
   * costs zero bandwidth in multiplayer.
   */
  readonly tick: number;
}
