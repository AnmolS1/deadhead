/**
 * Generate `migrations/0002_auth.sql` from the live Better Auth config.
 *
 * `TASKS.md` says to use `@better-auth/cli generate`. **Do not.** That package
 * is deprecated on npm ("no longer supported"), and its newest publish is
 * `1.5.0-beta.13` while the runtime here is `better-auth@1.7.2` — a generator
 * two minor versions behind the thing it generates for is exactly the drift the
 * instruction was written to prevent.
 *
 * `better-auth/db/migration` is the same code the CLI wrapped, exported from the
 * runtime package itself. Using it means the SQL and the running config are
 * produced by **one version**, so they cannot disagree.
 *
 * The database is a throwaway in-memory `node:sqlite`, and it has to be a real
 * one: with no `database` at all Better Auth builds its **memory adapter**, and
 * `getMigrations` refuses that with *"Only kysely adapter is supported for
 * migrations."* An empty database introspects as empty, so every auth table
 * lands in `toBeCreated` — which is what a first migration should contain.
 *
 * SQLite is the right dialect because **D1 is SQLite**: Better Auth's own D1
 * dialect reports `databaseType: 'sqlite'`, so the DDL it would plan against a
 * live D1 is the DDL planned here.
 *
 * The handle is passed RAW. The `{ db, type }` form wants an already-constructed
 * Kysely instance — hand it a bare `DatabaseSync` and it dies on
 * `db.introspection.getTables()` of undefined. Passing the handle itself lets
 * Better Auth's own detection choose the dialect, which is the point: the same
 * code path that would pick `D1SqliteDialect` in the Worker picks
 * `NodeSqliteDialect` here.
 *
 *   npm -w @deadhead/server run auth:schema         # write the file
 *   npm -w @deadhead/server run auth:schema:check   # fail if it is stale
 *
 * The `:check` form is in `check:all`. It is the same trick as `types:check`:
 * regenerate, diff, fail on difference — so upgrading `better-auth` without
 * writing the accompanying migration turns the gate red instead of turning
 * production red.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getMigrations } from 'better-auth/db/migration';

// From `dist`, not `src`. Node strips types but does not rewrite TypeScript's
// `.js` import specifiers back to `.ts`, so importing the source fails on
// `options.ts`'s own `import … from '../routes.js'`. Building first is also the
// established idiom here — `simrun`, `goldens` and `city:01` all run
// `npm run build && node <workspace>/dist/...`. The `auth:schema` script does
// the build for you.
import { authOptions } from '../dist/auth/options.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'migrations', '0002_auth.sql');

const HEADER = `-- 0002_auth.sql — Better Auth's schema. GENERATED; DO NOT EDIT BY HAND.
--
-- Produced by \`npm -w @deadhead/server run auth:schema\` from the config in
-- \`src/auth/options.ts\`, using better-auth's own migration builder at the exact
-- version the Worker runs. Editing this file by hand guarantees it stops
-- matching the config, and the failure mode is "nobody can log in".
--
-- To change it: change \`options.ts\`, re-run the generator, and commit both.
-- \`check:all\` fails if this file does not match what the config produces.
--
-- These four tables are Better Auth's, not the game's. \`0001_game_schema.sql\`
-- deliberately creates none of them, and \`players.id\` holds the auth user id —
-- the single coupling point between the two schemas.
`;

// `throwOnUnsafe` is irrelevant against an empty database (nothing to backfill),
// but leaving it on means a future config change that WOULD be unsafe fails here
// rather than silently emitting a migration that breaks on a populated D1.
const { compileMigrations, toBeCreated, unsafeChanges } = await getMigrations(
  { ...authOptions(), database: new DatabaseSync(':memory:') },
  { throwOnUnsafe: true },
);

if (unsafeChanges.length > 0) {
  console.error('Refusing to generate: unsafe changes reported:\n' + unsafeChanges.join('\n'));
  process.exit(1);
}

const sql = await compileMigrations();

if (!sql.trim()) {
  console.error('Refusing to generate: better-auth produced no SQL. Config lost its database?');
  process.exit(1);
}

// Guard against generating an empty or partial schema. The four tables are
// Better Auth's core; if a future version renames one, this fails loudly here
// rather than producing a migration that leaves auth half-built.
const REQUIRED = ['user', 'session', 'account', 'verification'];
const created = toBeCreated.map((t) => t.table);
const missing = REQUIRED.filter((t) => !created.includes(t));
if (missing.length > 0) {
  console.error(`Refusing to generate: expected tables not planned: ${missing.join(', ')}`);
  console.error(`Planned: ${created.join(', ') || '(none)'}`);
  process.exit(1);
}

const content = `${HEADER}\n${sql.trim()}\n`;

const check = process.argv.includes('--check');
if (check) {
  let existing = '';
  try {
    existing = readFileSync(target, 'utf8');
  } catch {
    console.error(`${target} does not exist. Run: npm -w @deadhead/server run auth:schema`);
    process.exit(1);
  }
  if (existing !== content) {
    console.error(
      `migrations/0002_auth.sql is STALE — it no longer matches src/auth/options.ts.\n` +
        `Regenerate it with: npm -w @deadhead/server run auth:schema\n` +
        `Then write a NEW numbered migration for the delta if 0002 is already applied anywhere.`,
    );
    process.exit(1);
  }
  console.log(`✨ migrations/0002_auth.sql matches the config (${created.length} tables).`);
} else {
  writeFileSync(target, content);
  console.log(`✨ Wrote migrations/0002_auth.sql — tables: ${created.join(', ')}`);
}
