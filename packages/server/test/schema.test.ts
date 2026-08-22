import { MAX_INPUT_LOG_BYTES, MAX_INPUT_LOG_TICKS } from '@deadhead/proto';
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * `B-02` — the schema, tested against the migrations that actually ship.
 *
 * `test/setup.ts` has already applied `migrations/` to `env.DB`, so everything
 * below runs against the same SQL `wrangler d1 migrations apply` executes.
 */

const now = 1_760_000_000_000;

async function addPlayer(id: string, name = id): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO players (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
  )
    .bind(id, name, now, now)
    .run();
}

interface RunOverrides {
  readonly id?: string;
  readonly player?: string;
  readonly mode?: string;
  readonly dailyDate?: string | null;
  readonly log?: ArrayBuffer;
  readonly ticks?: number;
  readonly score?: number;
  readonly verified?: number;
  readonly cityHash?: number;
  readonly submittedAt?: number;
}

async function addRun(overrides: RunOverrides = {}): Promise<void> {
  const {
    id = crypto.randomUUID(),
    player = 'p1',
    mode = 'practice',
    dailyDate = null,
    log = new Uint8Array(8).buffer,
    ticks = 5400,
    score = 1000,
    verified = 1,
    cityHash = 0x1234,
    submittedAt = now + 1000,
  } = overrides;

  await env.DB.prepare(
    `INSERT INTO runs (
       id, player_id, seed, city_hash, sim_version, input_format_version,
       mode, daily_date, started_at, submitted_at,
       score, deliveries, ticks, verified, input_log
     ) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, 3, ?, ?, ?)`,
  )
    .bind(id, player, 42, cityHash, mode, dailyDate, now, submittedAt, score, ticks, verified, log)
    .run();
}

beforeEach(async () => {
  // Order matters only because foreign keys are enforced; children first.
  for (const table of [
    'friends',
    'ratings',
    'match_players',
    'matches',
    'scores',
    'runs',
    'daily',
    'players',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await addPlayer('p1');
});

describe('migrations', () => {
  it('creates every table the game needs', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).all<{ name: string }>();

    const names = results.map((row) => row.name).filter((name) => name !== 'd1_migrations');
    expect(names).toStrictEqual([
      'daily',
      'friends',
      'match_players',
      'matches',
      'players',
      'ratings',
      'runs',
      'scores',
    ]);
  });

  it('does not create the auth tables — Better Auth generates those in B-03', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('user', 'users', 'session', 'sessions', 'account', 'verification')",
    ).all<{ name: string }>();
    expect(results).toStrictEqual([]);
  });

  it('rolls forward on an already-migrated database', async () => {
    // `B-02`'s done-when, literally: applying a second time must be a no-op
    // rather than an error, or a redeploy breaks the database.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{
      name: string;
    }>();
    expect(results.map((row) => row.name)).toStrictEqual(['0001_game_schema.sql']);
  });

  it('makes every table STRICT, so a typo cannot become data', async () => {
    // The point of STRICT: without it SQLite happily stores 'not-a-number' in
    // an INTEGER column and the error surfaces months later as a broken sort.
    await expect(
      env.DB.prepare('UPDATE players SET created_at = ? WHERE id = ?')
        .bind('yesterday', 'p1')
        .run(),
    ).rejects.toThrow();
  });
});

describe('runs', () => {
  it('accepts an input log at exactly the protocol maximum', async () => {
    // The CHECK in SQL and `MAX_INPUT_LOG_BYTES` in TypeScript are the same
    // number written in two languages, and SQL cannot import the constant. This
    // pair of tests is the only thing stopping them drifting.
    await expect(
      addRun({ log: new Uint8Array(MAX_INPUT_LOG_BYTES).buffer }),
    ).resolves.not.toThrow();
  });

  it('rejects an input log one byte over it', async () => {
    await expect(addRun({ log: new Uint8Array(MAX_INPUT_LOG_BYTES + 1).buffer })).rejects.toThrow();
  });

  it('rejects a tick count beyond the protocol maximum', async () => {
    await expect(addRun({ ticks: MAX_INPUT_LOG_TICKS })).resolves.not.toThrow();
    await expect(addRun({ ticks: MAX_INPUT_LOG_TICKS + 1 })).rejects.toThrow();
  });

  it('never stores the log outside D1 — 64 KiB fits a 2 MB column with room to spare', () => {
    // Written as an assertion rather than a comment because it is the reason
    // `B-02`'s "else R2" branch does not exist. If the protocol cap is ever
    // raised past D1's limit, this fails and the decision gets revisited.
    const D1_MAX_BLOB_BYTES = 2_000_000;
    expect(MAX_INPUT_LOG_BYTES).toBeLessThan(D1_MAX_BLOB_BYTES);
  });

  it('requires a daily run to carry a date and a practice run not to', async () => {
    await expect(addRun({ mode: 'daily', dailyDate: null })).rejects.toThrow();
    await expect(addRun({ mode: 'practice', dailyDate: '2026-08-21' })).rejects.toThrow();
    await expect(addRun({ mode: 'daily', dailyDate: '2026-08-21' })).resolves.not.toThrow();
  });

  it('rejects a mode nobody defined', async () => {
    await expect(addRun({ mode: 'ranked' })).rejects.toThrow();
  });

  it('allows one daily run per player per day and refuses the second', async () => {
    await addRun({ mode: 'daily', dailyDate: '2026-08-21' });
    await expect(addRun({ mode: 'daily', dailyDate: '2026-08-21' })).rejects.toThrow();

    // A different day is fine, and so is a different player on the same day.
    await expect(addRun({ mode: 'daily', dailyDate: '2026-08-22' })).resolves.not.toThrow();
    await addPlayer('p2');
    await expect(
      addRun({ player: 'p2', mode: 'daily', dailyDate: '2026-08-21' }),
    ).resolves.not.toThrow();
  });

  it('does not constrain how many practice runs a player submits', async () => {
    await addRun();
    await expect(addRun()).resolves.not.toThrow();
  });

  it('deletes a player’s runs with the player', async () => {
    await addRun();
    await env.DB.prepare('DELETE FROM players WHERE id = ?').bind('p1').run();

    const { results } = await env.DB.prepare('SELECT id FROM runs').all();
    expect(results).toStrictEqual([]);
  });

  it('refuses a run belonging to nobody', async () => {
    await expect(addRun({ player: 'ghost' })).rejects.toThrow();
  });
});

describe('the leaderboard index', () => {
  it('serves the top-N query without scanning the table', async () => {
    // The index is the whole reason `B-09` can answer in a few milliseconds.
    // Asserting it *exists* proves nothing — the planner has to choose it.
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
         SELECT id, score FROM runs
          WHERE verified = 1 AND city_hash = ? AND sim_version = ?
          ORDER BY score DESC, deliveries DESC
          LIMIT 10`,
    )
      .bind(0x1234, 0)
      .all<{ detail: string }>();

    const plan = results.map((row) => row.detail).join(' | ');
    expect(plan).toContain('runs_board');
    expect(plan).not.toContain('SCAN runs');
    // A separate sort step would mean the index's column order is wrong for
    // this query, which is the mistake worth catching.
    expect(plan).not.toContain('USE TEMP B-TREE');
  });
});

describe('matches', () => {
  it('holds a lobby to the 3–12 the world layout supports', async () => {
    const insert = (count: number) =>
      env.DB.prepare(
        `INSERT INTO matches (id, seed, city_hash, sim_version, ranked, win_threshold, player_count, started_at)
         VALUES (?, 1, 1, 0, 1, 5, ?, ?)`,
      )
        .bind(crypto.randomUUID(), count, now)
        .run();

    await expect(insert(3)).resolves.not.toThrow();
    await expect(insert(12)).resolves.not.toThrow();
    await expect(insert(2)).rejects.toThrow();
    await expect(insert(13)).rejects.toThrow();
  });
});

describe('friends', () => {
  it('refuses to let a player friend themselves', async () => {
    await expect(
      env.DB.prepare(
        'INSERT INTO friends (player_id, friend_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('p1', 'p1', 'pending', now, now)
        .run(),
    ).rejects.toThrow();
  });

  it('stores each direction separately, so "who asked" survives', async () => {
    await addPlayer('p2');
    await env.DB.prepare(
      'INSERT INTO friends (player_id, friend_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('p1', 'p2', 'pending', now, now)
      .run();

    await expect(
      env.DB.prepare(
        'INSERT INTO friends (player_id, friend_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind('p2', 'p1', 'accepted', now, now)
        .run(),
    ).resolves.not.toThrow();
  });
});
