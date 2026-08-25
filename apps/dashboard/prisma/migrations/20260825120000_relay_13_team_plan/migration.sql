-- [RELAY-13] Per-team rate-limit tier.
--
-- Purely additive/expand: a new enum type and a new column with a default, on an
-- existing table. No backfill statement is needed (contrast
-- 20260807173000_relay_57_ingest_token, which DID need one) because every existing row
-- gets the column's default (FREE) applied by Postgres for free — there is no NOT NULL
-- column here that lacks a safe value for rows that already exist.
--
-- Nothing reads or writes anything but FREE through this migration. The write path that
-- moves a team onto PRO/ENTERPRISE (billing integration or an admin action) is separate,
-- later work — see the column's doc-comment in schema.prisma. This migration only makes
-- the column exist and safe to read, which is what apps/proxy/src/routes/ingest.ts and
-- apps/dashboard/pages/api/relay/internal/route-lookup.ts need to compile and run against.
--
-- Grants: no change needed. relay_app already holds
-- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` from
-- 20260804120000_relay_app_login_and_grants.sql, which is table-level and therefore
-- already covers this new column — verified by reading that grant statement directly,
-- not assumed.

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');

-- AlterTable
ALTER TABLE "Team" ADD COLUMN "plan" "Plan" NOT NULL DEFAULT 'FREE';
