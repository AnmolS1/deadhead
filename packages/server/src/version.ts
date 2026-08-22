/**
 * The wire/behaviour version of this Worker, reported by `/health`.
 *
 * Bump when the API surface changes in a way a deployed client would notice.
 * Distinct from `SIM_VERSION`, which versions determinism: a sim bump
 * invalidates replays and leaderboard entries, a server bump does not.
 */
export const SERVER_VERSION = 0;
