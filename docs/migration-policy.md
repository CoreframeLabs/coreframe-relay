# Migration policy (RELAY-41)

This is the policy the mechanism in `.github/workflows/migrate.yml` and
`apps/dashboard/scripts/build.sh` exists to enforce. Those two close *how* a migration
reaches a hosted database (never `db push`, always a dedicated CI job on a DDL-capable
credential distinct from the app's own `relay_app` role — see
`__tests__/relay/relay-41.test.ts` for the live proof of that role split). This document is
the missing third piece: *what a migration is allowed to contain* before it is even a
candidate to run through that path.

## The rule

**A migration that ships in one deploy must be additive.** It may create — a table, a
column, an index, an enum value — but it may not remove or reinterpret anything the
currently-deployed application code still depends on. Destructive change (drop a column,
rename a column, narrow a type, remove an enum value) is real and sometimes necessary, but
it never happens in the same deploy that stops using the old shape. It happens in a LATER
deploy, after the application has been running against the new shape for a bake period —
this is the expand/contract pattern, and the rest of this document is what that looks like
against this actual schema, not a textbook one.

Why this matters more here than in a single-writer app: `apps/dashboard` (Vercel, rolling
deploys) and `apps/proxy` (Cloudflare Workers) are two independently-deployed processes
reading the same database, and `prisma migrate deploy` runs from a separate CI job with no
coordination to either app's deploy timing. A migration that drops a column the
currently-running dashboard instance still selects does not wait for that instance to
finish deploying — it breaks it the moment the migration commits, for however long the old
and new deploys overlap.

## What "additive" means, concretely

| Change | Additive (one deploy)? | Why |
|---|---|---|
| `CREATE TABLE` | Yes | Nothing depended on it not existing. `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` (`20260804120000_relay_app_login_and_grants.sql`) already grants `relay_app` DML on it automatically — no follow-up grant migration needed. |
| `ADD COLUMN ... DEFAULT <value>` | Yes | Every existing row gets a value for free; old code that doesn't know the column exists is unaffected. Real example already in this schema: the `[RELAY-13]` migration below. |
| `ADD COLUMN` with no safe default, `NOT NULL` | Only with a backfill in the same migration | See the `ingestToken` example below — the column can't be additive-by-default when there is no single correct default value per row. |
| `CREATE INDEX` | Yes, but see the caveat | Postgres locks the table for writes for the duration of a plain `CREATE INDEX`. On a table `DeliveryLog`/`DlqItem`-sized this is a real production risk; use `CREATE INDEX CONCURRENTLY` outside a transaction block (Prisma migrations run inside one by default — this needs `prisma migrate diff` + manual editing, or a raw `supabase db push` migration, not the default generated SQL). |
| Add a value to an existing enum (`ALTER TYPE ... ADD VALUE`) | Yes | Existing rows and existing code are unaffected; nothing currently reads the new value. |
| `DROP COLUMN`, `DROP TABLE` | No — never in the same deploy that stops using it | The currently-running old deploy is still selecting it. |
| `RENAME COLUMN`, `RENAME TABLE` | No | Identical failure mode to a drop, from Postgres's point of view — the old name stops existing atomically. Prisma has no "keep both names" primitive, so a rename is always modelled as add-new + drop-old across two deploys, never one `RENAME`. |
| Narrow a column's type, remove a `CHECK`-compatible value, remove an enum value | No | Same shape as a drop: the old, wider contract stops being honoured for rows or code that still assume it. |
| RLS policy changes (`supabase/migrations/`) | Same discipline, different tool | `prisma migrate deploy` does not apply this directory at all (`docs/rls.md`) — it runs through `supabase db push` as `migrate.yml`'s separate step. A policy that starts denying rows the running app still queries unscoped is exactly as destructive as a dropped column, and this is not hypothetical: `20260821130000_relay_app_permissive_policy_non_relay_tables.sql`'s own header records the app-breaking version of this exact mistake happening for real on 2026-08-21 (RLS enabled with zero policies on 16 tables, discovered when `prisma.user.create()` started failing signup in production) — the fix that migration ships is what should have shipped BEFORE the tightening, not after: a permissive policy landing first, tightened only once every reader/writer is confirmed to not need the old unrestricted access. |

## Two real precedents already in this schema

Not hypothetical — both migrations below already shipped and are exactly the two shapes
"additive" splits into.

**No backfill needed** — `20260825120000_relay_13_team_plan/migration.sql`:

```sql
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');
ALTER TABLE "Team" ADD COLUMN "plan" "Plan" NOT NULL DEFAULT 'FREE';
```

`NOT NULL` and no backfill statement in the same migration, because the column has one
correct value for every row that already exists (`FREE`, the most restrictive tier) — the
`DEFAULT` clause is Postgres doing the backfill as part of adding the column, atomically,
with no separate `UPDATE` pass.

**Backfill needed** — `20260807173000_relay_57_ingest_token/migration.sql`:

```sql
CREATE OR REPLACE FUNCTION ingestToken_backfill() RETURNS text ...;
ALTER TABLE "Route" ADD COLUMN "ingestToken" TEXT;
UPDATE "Route" SET "ingestToken" = ingestToken_backfill() WHERE "ingestToken" IS NULL;
ALTER TABLE "Route" ALTER COLUMN "ingestToken" SET NOT NULL;
CREATE UNIQUE INDEX "Route_ingestToken_key" ON "Route"("ingestToken");
```

No single default value is correct here — every existing `Route` needs its OWN random
token, not the same one — so the column is added nullable, backfilled with a distinct
value per row, and only THEN constrained `NOT NULL`. Still one deploy, still additive from
the running application's point of view at every intermediate statement: a column that
doesn't exist yet, then a nullable column old code ignores, then a fully-populated one.

## Worked example: renaming `Team.billingId` → `Team.stripeCustomerId`

This one has not happened — it is a plausible, concrete future change picked because it is
real: `Team.billingId` (`prisma/schema.prisma`) is a generic name for what is, in every
place that reads or writes it today, specifically a Stripe customer id
(`apps/dashboard/lib/stripe.ts`'s `getStripeCustomerId`, and the webhook handler at
`apps/dashboard/pages/api/webhooks/stripe.ts`, both against a `billingProvider` column that
has only ever been set to the literal string `'stripe'`). Renaming it for clarity is
exactly the kind of change that is tempting to do as one `RENAME COLUMN` and genuinely
dangerous to do that way, because `Team` has no RLS policy — it is read by the ambient
Prisma client on every request that touches a team, so a window where the running code and
the schema disagree about the column's name is a 500 on that request, not a degraded
feature.

### Deploy 1 — expand

Add the new column, dual-write both, backfill, and switch READS to the new column with a
fallback — all while the OLD column still exists and old code paths are unaffected.

```sql
-- migration.sql
ALTER TABLE "Team" ADD COLUMN "stripeCustomerId" TEXT;
UPDATE "Team" SET "stripeCustomerId" = "billingId" WHERE "billingId" IS NOT NULL;
-- No UNIQUE constraint yet — billingId's own constraint (if any) still governs writes
-- until deploy 2. Adding one here before both columns are proven in sync would risk a
-- migration failing on a divergence this deploy hasn't caused yet.
```

Application changes shipped in the SAME deploy as this migration:

```ts
// lib/stripe.ts's getStripeCustomerId — WRITE both columns, so a mid-rollout read from
// either is correct.
await updateTeam(teamMember.team.slug, {
  billingId: customer.id,        // old — still read by any pod not yet on this deploy
  stripeCustomerId: customer.id, // new — what deploy 2 will read exclusively
  billingProvider: 'stripe',
});

// Anywhere billingId was READ (getStripeCustomerId's own `else` branch, and any other
// call site), prefer the new column with a fallback, never the reverse — this is what
// makes the cutover safe to observe before deploy 2 commits to it:
const customerId = teamMember.team.stripeCustomerId ?? teamMember.team.billingId;
```

Bake period: this deploy runs in production long enough to confirm (via a real query, not
assumption) that `stripeCustomerId` is non-null everywhere `billingId` is, and that no log
line or metric shows the fallback branch (`?? team.billingId`) firing for a team created
AFTER this deploy — a hit there means dual-write is broken, not that the rename is ready.

### Deploy 2 — contract

Only after that bake period, and only in a SEPARATE later deploy:

```sql
-- migration.sql
ALTER TABLE "Team" ALTER COLUMN "stripeCustomerId" SET NOT NULL;
ALTER TABLE "Team" DROP COLUMN "billingId";
```

Application changes shipped in the SAME deploy as this migration: delete the dual-write
(only `stripeCustomerId` is written now) and delete the `?? team.billingId` fallback (only
`stripeCustomerId` is read now). This is the deploy where `billingId` actually stops
existing — safe now because nothing in the currently-shipping code reads or writes it,
which deploy 1's bake period is what established.

### What this buys, stated as the failure it prevents

A single `ALTER TABLE "Team" RENAME COLUMN "billingId" TO "stripeCustomerId";` run through
`migrate.yml` commits atomically at the database, but Vercel's rollout is NOT atomic with
it — old and new dashboard instances serve traffic side by side for the length of the
rollout. Every old-code request touching `team.billingId` during that window throws
(`column "billingId" does not exist`), on the table that gates every team-scoped page in
the product. The two-deploy version has no such window: at every point either column can
be missing from the CODE's expectations but never from the DATABASE's actual shape until
the deploy that stopped needing it has already fully rolled out.
