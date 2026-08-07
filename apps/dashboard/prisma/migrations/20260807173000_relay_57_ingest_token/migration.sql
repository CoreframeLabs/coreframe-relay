-- [RELAY-57] Per-route ingest token: `Route.ingestToken` (unique, high-entropy).
--
-- Backfill strategy: the column must be UNIQUE and NOT NULL, and existing rows need a
-- DISTINCT random token each. `gen_random_bytes` comes from pgcrypto, available on
-- Supabase and the local stack. Prisma can't express `crypto.randomBytes(24)` as a
-- default, so the migration installs a backfill function, backfills, then keeps the
-- function around — the app's `createRoute`/`rotateIngestToken` generate in Node and
-- the function exists only for this one-time backfill and any future ops use.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- base64url without padding, URL-safe by construction.
CREATE OR REPLACE FUNCTION ingestToken_backfill() RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT translate(
    encode(gen_random_bytes(24), 'base64'),
    '+/=',
    '-_'
  )
$$;

ALTER TABLE "Route" ADD COLUMN "ingestToken" TEXT;

-- One statement per row would issue N round-trips; a single set-based UPDATE assigns a
-- fresh token per row because a VOLATILE function is evaluated per row in Postgres.
UPDATE "Route" SET "ingestToken" = ingestToken_backfill() WHERE "ingestToken" IS NULL;

ALTER TABLE "Route" ALTER COLUMN "ingestToken" SET NOT NULL;

-- Unique index doubles as the proxy's accept-by-token index.
CREATE UNIQUE INDEX "Route_ingestToken_key" ON "Route"("ingestToken");
