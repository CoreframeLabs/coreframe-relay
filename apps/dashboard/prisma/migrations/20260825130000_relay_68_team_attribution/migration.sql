-- [RELAY-68] n8n-wedge channel attribution.
--
-- Purely additive: three new nullable TEXT columns and one new BOOLEAN column with a
-- default, on an existing table (Team). Follows docs/migration-policy.md's "no backfill
-- needed" shape (contrast the "needs one" shape at
-- 20260807173000_relay_57_ingest_token/migration.sql) — every new column here has a
-- value that is correct for every row that already exists, so a plain
-- ADD COLUMN [DEFAULT] does the entire backfill atomically. Structurally this mirrors
-- two real precedents already in this schema, both single nullable/defaulted columns
-- added to a high-read, ambiently-loaded table with no RLS policy of its own:
--   - 20260808043000_relay_50_deliverylog_istest (DeliveryLog.isTest)
--   - 20260825120000_relay_13_team_plan (Team.plan)
--
-- attributionSource/Medium/Campaign are nullable with NO default: unlike Team.plan's
-- FREE (one real, correct value for every existing row), there is no single correct
-- attribution value for a team that signed up before this ticket's capture flow
-- existed. NULL honestly represents "unknown" — models/n8nChannelMetrics.ts counts
-- against a fixed 6-value UTM-source allowlist, and a manufactured non-NULL default
-- would either silently join that allowlist (inflating the channel count) or need its
-- own permanent carve-out in every query that reads this column.
--
-- isInternal gets `NOT NULL DEFAULT false`, the same shape as Team.plan and
-- DeliveryLog.isTest: every existing team is correctly `false` because the
-- coreframe-labs.dev-domain check this column represents did not exist before this
-- migration, so no historical row was ever evaluated against it — `false` is not a
-- guess, it is the only value that could be true of every existing row.
--
-- Grants: no change needed. relay_app already holds
-- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` from
-- 20260804120000_relay_app_login_and_grants.sql, which is table-level and therefore
-- already covers these new columns on the existing Team table — verified by reading
-- that grant statement directly, same as 20260825120000_relay_13_team_plan's own note.

ALTER TABLE "Team" ADD COLUMN "attributionSource" TEXT;
ALTER TABLE "Team" ADD COLUMN "attributionMedium" TEXT;
ALTER TABLE "Team" ADD COLUMN "attributionCampaign" TEXT;
ALTER TABLE "Team" ADD COLUMN "isInternal" BOOLEAN NOT NULL DEFAULT false;
