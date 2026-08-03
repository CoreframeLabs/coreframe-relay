# RELAY-11: Row Level Security on the Relay tables

Migration: `supabase/migrations/20260804010000_relay_rls.sql`
Tables: `Route`, `DeliveryLog`, `DlqItem`, `GateRule`, `ApprovalRequest`, `AuditLog`.

## The one-sentence answer

**RLS as implemented today does NOT protect the app's Prisma path.** It protects
every *other* path to these tables. The Prisma path is still protected by
exactly what it was protected by before this migration: every query
remembering its `teamId` filter. This document explains why, what was
verified, and what a real fix looks like.

## Why Prisma bypasses RLS regardless of what the migration does

The dashboard's `DATABASE_URL` (`apps/dashboard/.env`) connects as:

```
postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

i.e. as the `postgres` role. Checked directly against the running local
Postgres 17.6 instance:

```
 rolname  | rolsuper | rolbypassrls
----------+----------+--------------
 postgres | f        | t
```

`postgres` is **not** the literal Postgres superuser on this stack (that's
`supabase_admin`, which is `rolsuper=t` — this stack's real bootstrap
superuser is not the role the app connects as). But `postgres` carries the
`BYPASSRLS` attribute directly, and per Postgres semantics that is
sufficient on its own:

> Database superusers and roles with the `BYPASSRLS` attribute always bypass
> the row security system when accessing a table.

Critically, **`FORCE ROW LEVEL SECURITY` does not change this.** `FORCE` only
removes the *table owner's* usual exemption from RLS. It has no effect on a
role that carries `BYPASSRLS`, superuser or not — that exemption cannot be
turned off from the table side at all; it is purely a role attribute. So no
combination of `ENABLE`/`FORCE ROW LEVEL SECURITY` and policy design changes
what Prisma sees, as long as it connects as `postgres`. This was verified
directly (see "What was verified" below): with RLS + FORCE enabled and a
policy in place, a session connected as `postgres` still saw both teams' rows
regardless of what session variable was set.

This means: if a future Prisma query is written without its `teamId` filter,
this migration does **not** stop the leak. That risk is unchanged by RELAY-11
as shipped.

## What the migration does protect

1. **PostgREST via `anon` / `authenticated`.** These are the roles a
   Supabase client (`supabase-js`) would use to hit these tables through the
   Data API. A grep of the codebase found **no `supabase-js` / PostgREST
   usage anywhere in `apps/dashboard` or `apps/proxy`** — every access to
   these six tables goes through Prisma. So today this protects a path the
   app doesn't use. It still matters: it's the backstop for the day someone
   adds a Supabase-client integration, exposes these tables to Studio's API
   explorer, or `auto_expose_new_tables` gets flipped on
   (`supabase/config.toml` currently leaves it unset for exactly this
   reason — new tables are not auto-exposed).

   Also worth stating plainly: `anon`/`authenticated` don't currently even
   have `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants on these six tables (only
   `TRUNCATE`/`REFERENCES`/`TRIGGER`/`MAINTAIN`, Supabase's default for
   tables not opted into the Data API). So right now these tables are
   already unreachable via PostgREST at the grant level, before RLS is even
   evaluated. RLS is a second, independent layer under those grants, so if
   the grants are ever loosened, the tables fail closed instead of open.

2. **Any other non-bypassrls connection** — a future service account, a
   teammate running ad hoc queries via Studio's SQL editor under a role that
   isn't `postgres`/`service_role`, a compromised low-privilege credential,
   etc.

3. **Cross-team writes and reads under a hypothetical future app role** — see
   next section.

## Why the policies use `app.current_team_id`, not `auth.uid()`

The obvious Supabase-native pattern is a policy like:

```sql
USING ("teamId" IN (SELECT "teamId" FROM "TeamMember" WHERE "userId" = auth.uid()))
```

This was considered and rejected for this schema. This app authenticates
through NextAuth, not Supabase Auth — `TeamMember.userId` points at this
app's own `User.id`, which has no relationship to `auth.users` /
`auth.uid()` at all. A policy written against `auth.uid()` would return NULL
for every real caller, forever, since no caller here ever presents a
Supabase-issued JWT tied to a `User` row. That would silently deny
everyone — which is safe, but it is indistinguishable from theater: it
can never be demonstrated to actually isolate "Team A from Team B" because
there is no path by which Team A is ever let in either. Shipping a policy
that can only be verified as "denies everyone" while being described as
"team isolation" would misrepresent what was built, so it wasn't used.

Instead, policies check a session-local Postgres setting:

```sql
USING ("teamId" = current_setting('app.current_team_id', true))
```

`DeliveryLog` and `DlqItem` only carry `routeId`, not `teamId`, so their
policies join through `Route`:

```sql
USING (EXISTS (
  SELECT 1 FROM "Route" r
  WHERE r.id = "DeliveryLog"."routeId"
    AND r."teamId" = current_setting('app.current_team_id', true)
))
```

`current_setting(..., true)` returns `NULL` when the setting was never made,
and `"teamId" = NULL` is never true in SQL — so the default is **deny**, not
allow, if a caller forgets to set it. This was verified directly.

This is a legitimate, commonly used pattern for apps that manage their own
auth outside Postgres roles (the setting is meant to be assigned via
`SET LOCAL` inside the same transaction as the query, by trusted server code,
**after** that code has verified the caller's team membership from their own
session — never from a client-supplied header or body field, which is what
the acceptance criteria's "not a client-supplied id" is guarding against).

**As shipped, nothing sets `app.current_team_id`.** No app code was touched
by this migration (per the task's file boundaries — only
`supabase/migrations/`, `prisma/migrations/`, and `docs/` were edited). The
policies exist and are enforced against any role that isn't `postgres` or
`service_role`, but nothing in the current request path ever assigns that
setting, so the policies apply to zero live traffic until a follow-up wires
it up.

## What was verified (not assumed)

Run against the live local stack, `supabase_db_coreframe-relay`
(Postgres 17.6, `127.0.0.1:54322`), after applying the migration with
`supabase migration up --local` (confirmed tracked in
`supabase_migrations.schema_migrations`, not applied by hand):

- `pg_class.relrowsecurity` and `relforcerowsecurity` are both `t` for all
  six tables.
- `pg_policies` shows one `ALL`-command policy per table with the expected
  `qual`/`with_check` expressions.
- A dedicated role `relay_app` was created: `rolsuper=f`, `rolbypassrls=f`,
  `rolcanlogin=f` (not yet wired to any connection — see "Recommended
  follow-up"), granted `SELECT/INSERT/UPDATE/DELETE` on the six tables.
- Seeded two teams (`team-a`, `team-b`) with one row per team in every one
  of the six tables (`Route`, `DeliveryLog`, `DlqItem`, `GateRule`,
  `ApprovalRequest`, `AuditLog`), with `DeliveryLog`/`DlqItem` rows pointing
  at each team's own `Route` via `routeId`.
- Connected as `relay_app` (non-bypass), `SET app.current_team_id = 'team-a'`:
  - `SELECT` with no filter on `Route` returned **only** `route-a`.
  - `SELECT ... WHERE id = 'route-b'` (Team B's real, valid id) returned
    **zero rows**, for `Route` and, via the `routeId` join, for
    `DeliveryLog` and `DlqItem`, and directly for `GateRule`,
    `ApprovalRequest`, and `AuditLog`.
  - `UPDATE "Route" SET name = 'hijacked' WHERE id = 'route-b'` affected
    **zero rows** (`WITH CHECK` blocked it); confirmed afterward, reconnected
    as `postgres`, that `route-b` was untouched.
  - The positive control — `SELECT ... WHERE id = 'route-a'` and the
    matching `DeliveryLog`/`DlqItem` rows — **did** return Team A's own
    data, proving the policy isolates rather than just denies everything.
  - With `app.current_team_id` unset (`RESET`), the same queries returned
    **zero rows**, confirming default-deny.
- Reconnected as `postgres` (the actual Prisma role) with
  `app.current_team_id` still set to `team-a`: `SELECT id, "teamId" FROM
  "Route"` returned **both** `route-a` and `route-b`. This is the concrete
  demonstration that RLS is fully inert on the role Prisma actually uses —
  the policy was in effect and correctly scoped, and `postgres` still saw
  everything, because `BYPASSRLS` overrides it unconditionally.
- All test fixtures (`team-a`, `team-b`, and their rows in all six tables)
  were deleted afterward; the migration itself leaves no seed data behind.

## Recommended follow-up (not done here — out of this ticket's file boundaries)

To make RLS actually cover the Prisma path, three things have to happen
together, none of which are safe to do inside a SQL-migrations-only ticket:

1. Give `relay_app` (already created by this migration) a login password,
   out of band — not committed to git.
2. Point `DATABASE_URL` at `relay_app` instead of `postgres`.
3. Add a `SET LOCAL app.current_team_id = $verifiedTeamId` (via
   `$queryRaw`/middleware, or a Prisma Client Extension) at the start of
   every request's transaction, sourced from the authenticated session —
   never from a request parameter — before any Relay-table query runs.

Until all three land, RLS on these six tables is a real, verified backstop
against direct/PostgREST/non-`postgres`-role access, and a no-op against the
app's actual Prisma traffic.
