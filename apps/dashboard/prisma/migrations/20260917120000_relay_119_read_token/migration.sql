-- [RELAY-119] `RelayReadToken` — a scoped, route-pinned, read-only machine credential.
--
-- The decision this implements is `growth/product/relay-119-121-122-decision-2026-09-17.md`
-- §1 (Option B of `relay-119-auth-decision.md`): a NEW table, not an extension of `ApiKey`
-- (no user, no role, no scope, zero callers) and not a reuse of `Route.ingestToken` (a
-- write capability that already lives in n8n workflow exports — reusing it would turn
-- every previously leaked ingest URL into a read credential on deploy day).
--
-- Purely additive: one new table, one unique index on the hash (the lookup IS the
-- authentication, so this index is what makes an unauthenticated miss cost one indexed
-- probe), one composite index for the per-route list view, two cascading FKs. Nothing
-- existing is altered. `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`
-- (20260804120000_relay_app_login_and_grants.sql) already grants relay_app DML on a new
-- table — see docs/migration-policy.md's CREATE TABLE row — so no grant is needed here.
--
-- `hashedToken` is the unsalted SHA-256 hex of the full `relay_rt_…` string (32 random
-- bytes' worth of prefix + 24 random bytes base64url = 192 bits of entropy). Unsalted is
-- correct for a random secret of that size: there is no dictionary to precompute, and a
-- salt would break the single-equality lookup that keeps a miss cheap.
--
-- `routeId` is NOT NULL on purpose — the route pin is a column constraint, not a `where`
-- clause the read handler has to remember. RELAY-DRAFT-7 may relax it later; that is a
-- separate additive migration (DROP NOT NULL), not this one's problem.
--
-- `createdByUserId` is a plain TEXT, deliberately without an FK to "User": the token
-- belongs to the team, not the minter. An ADMIN contractor's account being deleted must
-- not cascade-delete the customer's live n8n credential — OWNER revokes explicitly.
--
-- RLS does NOT live here — see the RELAY-59 migration's note in this same directory
-- tree; Row Level Security for the Relay tables stays in `supabase/migrations/`
-- (`20260917120000_relay_119_read_token_rls.sql` for this table). Applying this Prisma
-- migration alone leaves the table with no policy — readable/writable by relay_app
-- exactly like `ApiKey` is today — which is the correct "expand" state, not the finished
-- one; the supabase migration is what tightens it.

-- CreateTable
CREATE TABLE "RelayReadToken" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hashedToken" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastFour" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelayReadToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RelayReadToken_hashedToken_key" ON "RelayReadToken"("hashedToken");

-- CreateIndex
CREATE INDEX "RelayReadToken_teamId_routeId_createdAt_idx" ON "RelayReadToken"("teamId", "routeId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "RelayReadToken" ADD CONSTRAINT "RelayReadToken_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelayReadToken" ADD CONSTRAINT "RelayReadToken_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;
