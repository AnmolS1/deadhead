-- 0002_auth.sql — Better Auth's schema. GENERATED; DO NOT EDIT BY HAND.
--
-- Produced by `npm -w @deadhead/server run auth:schema` from the config in
-- `src/auth/options.ts`, using better-auth's own migration builder at the exact
-- version the Worker runs. Editing this file by hand guarantees it stops
-- matching the config, and the failure mode is "nobody can log in".
--
-- To change it: change `options.ts`, re-run the generator, and commit both.
-- `check:all` fails if this file does not match what the config produces.
--
-- These four tables are Better Auth's, not the game's. `0001_game_schema.sql`
-- deliberately creates none of them, and `players.id` holds the auth user id —
-- the single coupling point between the two schemas.

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create unique index "account_issuer_accountId_uidx" on "account" ("issuer", "accountId");
