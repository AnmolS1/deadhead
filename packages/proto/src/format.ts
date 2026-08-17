/**
 * Format versions.
 *
 * Every serialised artefact in this project is versioned from its first commit,
 * so a stale replay, a stale snapshot or a stale city is *rejected* rather than
 * silently misread as the current format. Getting that wrong is not a crash —
 * it is a leaderboard full of scores nobody can reproduce.
 *
 * These live in `@deadhead/proto` rather than in the packages that produce them
 * because both sides of every boundary need to agree on them: the client and
 * the Durable Object, the recorder and the replay validator.
 *
 * **Bump a version whenever the layout changes, in the same commit.** A version
 * that lags the layout it describes is worse than no version at all.
 */

/**
 * Layout of a serialised world (`packages/sim/src/world.ts`).
 *
 * Bumping this invalidates every stored snapshot and every mid-match resync
 * against an older build. It does *not* by itself invalidate an input log —
 * a log is replayed through `step()`, not deserialised — but a change to the
 * world layout usually means the sim changed too, which does. See the note on
 * `S-14` about never editing a golden to make a test pass.
 *
 * - **v2** (`S-09`): the passenger region's reserved slots 3–6 became
 *   `Destination`, `SpawnTick`, `PatienceTicks` and `Carrier`.
 */
export const WORLD_FORMAT_VERSION = 2;

/** Layout of a recorded input log. Owned by `S-12`. */
export const INPUT_FORMAT_VERSION = 0;

/** Layout of packed city data. Owned by `W-01`. */
export const CITY_FORMAT_VERSION = 0;

/** Layout of the per-tick match snapshot. Owned by `M-04`. */
export const NET_FORMAT_VERSION = 0;
