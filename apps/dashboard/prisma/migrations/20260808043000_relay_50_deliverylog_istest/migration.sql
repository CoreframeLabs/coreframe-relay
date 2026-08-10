-- [RELAY-50] "Send test webhook" marks every delivery it produces.
--
-- A `false` default backfills every historical row automatically — no UPDATE needed,
-- and the flag cannot be confused with "unknown" (nullable) either. `DeliveryLog` is
-- the highest-write table in the system ([RELAY-2]), and this is a non-indexed,
-- single-byte column: the badge on the feed filters on it in JS, not in the WHERE
-- clause, precisely because the feed's existing indexes already answer its queries and
-- this column serves display, not lookups.
ALTER TABLE "DeliveryLog" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;
