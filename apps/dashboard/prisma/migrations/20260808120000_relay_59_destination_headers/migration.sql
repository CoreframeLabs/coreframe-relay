-- [RELAY-59] Customer-configured destination auth headers, encrypted at rest.
--
-- Adds `Route.destinationHeadersEncrypted` — a nullable JSONB map of header name →
-- per-value AES-256-GCM envelope ({ iv, ct, tag } as base64), produced by
-- `apps/dashboard/lib/relay/destinationAuth.ts`. The key is app-level
-- (`RELAY_DESTINATION_HEADERS_KEY`), NOT here — this migration carries only the column.
-- Envelope encryption / KMS / per-team wrapping are deliberately out of scope on the
-- £0 infrastructure; the threat model is documented on the writer/reader.
--
-- RLS does NOT live here. Row Level Security for the Relay tables stays in
-- `supabase/migrations/` (Prisma cannot express `FORCE ROW LEVEL SECURITY`); applying
-- this Prisma migration must never be expected to set policies. See the dev-log note
-- under RELAY-40: `prisma migrate deploy` applies THIS directory only.

ALTER TABLE "Route" ADD COLUMN "destinationHeadersEncrypted" JSONB;
