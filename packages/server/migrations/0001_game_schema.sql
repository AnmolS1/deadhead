-- 0001_game_schema.sql — the game's own tables.
--
-- Scope note, because `B-02`'s brief lists more than this file creates.
--
--   * The **auth tables are deliberately absent.** Better Auth owns its own
--     schema and generates it from the live config with `@better-auth/cli
--     generate`; which plugins are enabled changes both the columns and the
--     tables. Hand-writing them here, before `B-03` picks that config, would
--     guarantee drift — and drift in an auth schema is silent until someone
--     cannot log in. The brief also names them `users` and `sessions`, while
--     Better Auth's defaults are singular (`user`, `session`, `account`,
--     `verification`) and it omits `account` entirely, which is where OAuth
--     credentials and the password hash live. `B-03` adds `0002_auth.sql`.
--
--   * `players.id` is the seam. It holds the Better Auth user id, and every
--     game table keys off `players`, not off the auth schema. That is not just
--     sequencing: `B-03` requires display names to be *separate from account
--     identity*, changeable, and moderated in `B-11`. `user.name` is who you
--     signed up as; `players.display_name` is what a leaderboard prints.
--
-- Conventions:
--   * All timestamps are INTEGER milliseconds since the Unix epoch, UTC.
--     Never a local time and never a string — a leaderboard sorts on these.
--   * `seed` and `city_hash` are INTEGER: both are 32-bit numbers in the sim
--     (`InputLog.seed`, `InputLog.cityHash`), and SQLite's INTEGER is 64-bit,
--     so they store exactly with no hex-string round-trip to get wrong.
--   * Every table is STRICT. This project spends a lot of effort keeping
--     int32 discipline in the sim; letting the database accept 'banana' in an
--     INTEGER column would be a strange place to stop caring.

-- ---------------------------------------------------------------------------
-- players
-- ---------------------------------------------------------------------------

CREATE TABLE players (
  -- The Better Auth user id. No FOREIGN KEY yet: the referenced table does not
  -- exist until `B-03`. Adding the constraint there requires a table rebuild in
  -- SQLite, which is exactly what a numbered migration is for.
  id TEXT PRIMARY KEY,

  -- What a leaderboard prints. NOT unique, deliberately: enforcing global
  -- uniqueness on display names is a product decision nobody has made, and
  -- `B-11` owns name moderation. If it should be unique, that is a migration
  -- and an index, not a thing to assume now.
  display_name TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- runs — one row per submitted single-player run
-- ---------------------------------------------------------------------------

CREATE TABLE runs (
  -- Minted server-side with the run token (`B-06`). The client never chooses it.
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,

  -- Also server-minted (`B-06`). Stored so `B-08` can re-run the log without
  -- trusting anything in the submission.
  seed INTEGER NOT NULL,

  -- ADR 0005 folds this into the run seed, so a city edit invalidates old
  -- entries rather than silently rescoring them. Stored to make the *reason* a
  -- board entry stopped matching legible, instead of a divergence mystery.
  city_hash INTEGER NOT NULL,

  -- A sim bump invalidates replays; a server bump does not. Both recorded so a
  -- spike in divergences can be attributed rather than guessed at.
  sim_version INTEGER NOT NULL,
  input_format_version INTEGER NOT NULL,

  mode TEXT NOT NULL CHECK (mode IN ('practice', 'daily')),
  -- 'YYYY-MM-DD', UTC. Exactly the daily runs carry one.
  daily_date TEXT,

  -- `started_at` is the server clock when the token was minted, NOT the
  -- client's tick-0 timestamp — which `S-12` explicitly marks untrusted.
  -- `B-07` compares the two to reject a run that claims to have been played
  -- faster than its tick count physically allows.
  started_at INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,

  -- As reported by the client. Believe `verified_score` instead once it is set.
  score INTEGER NOT NULL,
  deliveries INTEGER NOT NULL,
  ticks INTEGER NOT NULL,

  -- `B-08`. A failed validation is stored, not discarded: a rising divergence
  -- rate means either cheating or a determinism regression, and telling those
  -- apart needs the failures kept.
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  verified_at INTEGER,
  verified_score INTEGER,
  divergence_tick INTEGER,

  -- The input log itself, inline. **R2 is not needed and the brief's "else R2"
  -- branch should not be built.** `MAX_INPUT_LOG_BYTES` is 64 KiB and D1's
  -- maximum BLOB is 2,000,000 bytes, so the hard cap on a log is 3.3% of what a
  -- single D1 value holds — a realistic RLE'd log is a few hundred bytes. The
  -- CHECK below is asserted against the constant in `schema.test.ts` so the two
  -- cannot drift.
  input_log BLOB NOT NULL,

  CHECK (length(input_log) <= 65536),
  CHECK (ticks > 0 AND ticks <= 36000),
  CHECK (deliveries >= 0),
  CHECK (submitted_at >= started_at),
  -- A daily run has a date and a practice run does not. Written as an
  -- equivalence so neither direction can drift.
  CHECK ((mode = 'daily') = (daily_date IS NOT NULL)),
  -- Verification results arrive together or not at all.
  CHECK ((verified_at IS NULL) = (verified_score IS NULL))
) STRICT;

-- The top-N query: verified runs on one city and sim version, best first.
-- Deliveries is the `G-04` tiebreak, so it is in the index rather than a sort
-- D1 has to do after the fact.
CREATE INDEX runs_board
  ON runs (city_hash, sim_version, score DESC, deliveries DESC)
  WHERE verified = 1;

-- `/play/api/board/me` — a player's own history, newest first.
CREATE INDEX runs_by_player ON runs (player_id, submitted_at DESC);

-- `B-08`'s work queue: everything not yet validated, oldest first.
CREATE INDEX runs_unverified ON runs (submitted_at) WHERE verified = 0;

-- **One daily run per account, enforced by the database.** `B-09` also checks
-- this, but a check in application code loses a race with itself and this does
-- not. Partial, so practice runs are unconstrained.
CREATE UNIQUE INDEX runs_one_daily_per_player
  ON runs (daily_date, player_id)
  WHERE daily_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- daily — the seed everyone plays on a given UTC day (`G-06`)
-- ---------------------------------------------------------------------------

CREATE TABLE daily (
  date TEXT PRIMARY KEY,          -- 'YYYY-MM-DD', UTC
  seed INTEGER NOT NULL,
  city_hash INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- scores — materialised top-N per board
-- ---------------------------------------------------------------------------

CREATE TABLE scores (
  -- 'all-time' or 'daily:YYYY-MM-DD'.
  board TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  deliveries INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  PRIMARY KEY (board, rank)
) STRICT;

-- A player holds at most one rank on a board, so a rebuild cannot leave them
-- listed twice.
CREATE UNIQUE INDEX scores_one_rank_per_player ON scores (board, player_id);

-- ---------------------------------------------------------------------------
-- matches — one row per multiplayer match (`M-03` onward)
-- ---------------------------------------------------------------------------

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  seed INTEGER NOT NULL,
  city_hash INTEGER NOT NULL,
  sim_version INTEGER NOT NULL,
  ranked INTEGER NOT NULL CHECK (ranked IN (0, 1)),
  -- `M-09` tunes N per lobby size.
  win_threshold INTEGER NOT NULL CHECK (win_threshold >= 1),
  -- `DESIGN.md` §3 and `MAX_PLAYERS`: 3–12.
  player_count INTEGER NOT NULL CHECK (player_count BETWEEN 3 AND 12),
  -- The colo the `MatchRoom` was placed in, from `locationHint` at creation.
  -- A DO cannot move afterwards, so this is a fact about the match forever.
  colo TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
) STRICT;

CREATE TABLE match_players (
  match_id TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  -- NULL until the match ends. 1 is first place.
  placement INTEGER CHECK (placement IS NULL OR placement >= 1),
  deliveries INTEGER NOT NULL DEFAULT 0 CHECK (deliveries >= 0),
  earnings INTEGER NOT NULL DEFAULT 0,
  -- REAL, not a scaled integer: `M-12` has not chosen between Glicko-2 and a
  -- generalised Elo, and inventing a fixed-point scale for a number nobody has
  -- specified is how you end up with a migration to undo it. Unranked matches
  -- leave both NULL.
  rating_before REAL,
  rating_after REAL,
  PRIMARY KEY (match_id, player_id)
) STRICT;

CREATE INDEX match_players_by_player ON match_players (player_id);

-- ---------------------------------------------------------------------------
-- ratings — current standing per player (`M-12`)
-- ---------------------------------------------------------------------------

CREATE TABLE ratings (
  player_id TEXT PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
  rating REAL NOT NULL,
  matches_played INTEGER NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  updated_at INTEGER NOT NULL
  -- `M-12` adds whatever its chosen system needs — Glicko-2 wants `deviation`
  -- and `volatility`, Elo wants neither — in its own migration, under the ADR
  -- `CLAUDE.md` requires for the rating system. Not guessed at here.
) STRICT;

CREATE INDEX ratings_leaderboard ON ratings (rating DESC);

-- ---------------------------------------------------------------------------
-- friends (`M-11`)
-- ---------------------------------------------------------------------------

CREATE TABLE friends (
  player_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  -- One row per direction. A request is 'pending' on both sides' view until
  -- accepted; storing it directionally keeps "who asked" recoverable.
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, friend_id),
  CHECK (player_id <> friend_id)
) STRICT;

-- "Who has added me?" — the inbound direction, which the primary key cannot serve.
CREATE INDEX friends_inbound ON friends (friend_id, status);
