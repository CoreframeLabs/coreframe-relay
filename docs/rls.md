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

---

# RELAY-39: wiring the app onto `relay_app` so the policies above are not inert

Migration: `supabase/migrations/20260804120000_relay_app_login_and_grants.sql`
Code: `apps/dashboard/lib/db/scope.ts`, `lib/db/scoped-client.ts`, `lib/prisma.ts`
Tests: `apps/dashboard/__tests__/lib/rls.spec.ts`

Everything above this line describes the state RELAY-11 left: correct policies,
zero effect on the app. This section is the fix, and what it did and did not
close. Dated 2026-08-04/05.

## The one-sentence answer

The mechanism works and is proven on the hosted transaction pooler — **12 of 12
assertions pass as `relay_app`, including a 60-way concurrent isolation test** —
but `DATABASE_URL` has **deliberately NOT been flipped**, because doing so
without wiring `withTeamScope` into the request path would take every Relay
feature to zero rows. The remaining step is named precisely below.

## What changed in the database

`relay_app` was `NOLOGIN` with grants on 6 of 22 tables. Both were blockers:

* **Grants.** Measured: `public` holds 22 base tables; `relay_app` had grants on
  6. Repointing `DATABASE_URL` in that state kills NextAuth on the first
  `Session` read, long before any Relay query runs. The migration grants
  `SELECT/INSERT/UPDATE/DELETE` on all tables plus `USAGE, SELECT` on both
  sequences (`PasswordReset_id_seq`, `jackson_index_id_seq`), and sets
  `ALTER DEFAULT PRIVILEGES` so tables created by future `prisma migrate deploy`
  runs are not silently invisible.
* **LOGIN.** Granted in the migration. The **password is not in git** — generated
  with `openssl rand -base64 36` (40 chars, alphanumeric) and applied by hand
  with `ALTER ROLE relay_app WITH PASSWORD …` on local, staging and production.

Two things the migration deliberately does not do: it grants **no DDL** (so
`prisma db push` / `migrate deploy` fail loudly if ever pointed at the runtime
credential — this is RELAY-41's "migration role is NOT relay_app" criterion), and
it does **not** restate `NOSUPERUSER`/`NOBYPASSRLS`. Measured: `postgres` on both
Supabase stacks holds `CREATEROLE`, not `SUPERUSER`, and `CREATEROLE` may not set
the `SUPERUSER` or `BYPASSRLS` attributes even to the values they already have —
naming them fails the whole migration with `permission denied to alter role
(SQLSTATE 42501)`. The DO block at the end therefore *verifies* those attributes
instead of imposing them, and the test suite asserts the same three facts against
the live connection.

## Supavisor accepts a custom role — verified, not assumed

Supabase's pooler derives its tenant from the username, so it was an open
question whether a non-`postgres` role could connect at all. It can, as
`<role>.<project_ref>`. Verified on production, both ports:

```
port 5432 (session mode)     -> relay_app | rolbypassrls=f
port 6543 (transaction mode) -> relay_app | rolbypassrls=f
```

## The measurement that dictated the design

A plain `SET` and a `SET LOCAL` look interchangeable in code review. They are
not, and on a transaction-mode pooler the difference is a cross-tenant read.
Same test, same project (staging `ghusprhbptdmdqgyjepf`), both ports:

| | one client does `SET app.current_team_id='LEAKED'`, disconnects; 6 fresh clients then read |
|---|---|
| **session mode `:5432`** | 0 of 6 saw it |
| **transaction mode `:6543`** | **6 of 6 saw it** |

Reproduced independently on production (`:6543`): 5 of 5 fresh connections read
back a value set by a client that had already disconnected. In transaction mode
a session-level `SET` is pinned to the pooled **server** connection, outlives the
client that set it, and is handed to whoever gets that connection next. On a
tenant-scoping GUC that is exactly the leak this ticket exists to prevent.

Both pollutions were swept afterwards (`RESET app.current_team_id` across 40
connections; verified 14/15 and 10/10 subsequently NULL).

By contrast `set_config('app.current_team_id', $1, true)` — the function form of
`SET LOCAL` — inside an explicit transaction returned the value correctly inside
the transaction and NULL immediately after COMMIT, **in both pooling modes**. So
the answer to "does it work on transaction pooling" is **yes, for `SET LOCAL`
inside a transaction, and emphatically no for a bare `SET`.**

## The shape chosen, and the one that was rejected

Every query on the six protected models runs as a Prisma **batch** transaction:

```ts
const [, result] = await client.$transaction([
  client.$executeRaw(Prisma.sql`SELECT set_config('app.current_team_id', ${teamId}, true)`),
  query(args),
]);
```

An **interactive** transaction (`$transaction(async tx => …)`) was rejected: it
holds a pooled server connection open across application-level awaits, which in
transaction mode is precisely the shape that serialises requests under load. The
batch form sends the unit and releases at COMMIT. Measured — it does not
serialise:

| environment | unscoped | scoped | overhead | 30 in parallel |
|---|---|---|---|---|
| local (`127.0.0.1:54322`) | 3.09 ms | 9.09 ms | **+6.00 ms (194%)** | 35 ms wall vs ~273 ms if serialised |
| production `:6543` (London, from UK dev box) | 833.89 ms | 1131.69 ms | **+297.79 ms (36%)** | 2179 ms wall vs ~33951 ms if serialised |
| staging `:5432` (Singapore, `connection_limit=5`) | 393.39 ms | 1601.03 ms | **+1207.64 ms (307%)** | 9746 ms wall vs ~48031 ms if serialised |

**Read those absolute numbers with care.** They are dominated by the link from
this development machine, not by the wrapper. Decomposed on production:

```
bare SELECT 1 (one round trip)          779.2 ms   <- the link, not us
SELECT 1 inside a batch transaction     796.5 ms   <- BEGIN/COMMIT costs ~17 ms
set_config + SELECT 1 in a transaction 1125.0 ms
```

So the cost is **one extra statement round trip per query**; BEGIN/COMMIT itself
is ~17 ms and effectively pipelined. The honest production estimate is therefore
"one additional round trip", which on the local stack is +6 ms and from an
in-region deployment (Vercel London → pooler London) should be closer to the
local figure than to the 298 ms measured over this WAN link. **That last clause
is reasoning, not measurement** — nothing has been deployed in-region yet.

## Session mode exhausts where transaction mode does not

Running the suite against staging `:5432` with Prisma's default pool produced
3 failures, all `Can't reach database server`. That is pool exhaustion, **not**
an isolation failure — the two are indistinguishable in a test summary and mean
completely different things, so it was confirmed rather than assumed: with
`?connection_limit=5&pool_timeout=60` the same suite reports
**60 interleaved queries across 2 tenants, 0 cross-tenant violations.**
Production `:6543` passed all 12 with default pool settings. This is a further
argument for the app staying on transaction mode.

## The bug this found in its own implementation

`withTeamScope` originally read `storage.run({ teamId }, fn)`. That is subtly
wrong. A Prisma client extension's `query` hook does not run when you *call*
`prisma.route.findMany(...)` — it runs when the returned PrismaPromise is
**awaited**. So `await withTeamScope(id, () => prisma.route.findMany(...))`
created the promise inside the AsyncLocalStorage store and resolved it outside,
`currentTeamId()` returned `undefined`, and no scope was ever set. Observed:
`new row violates row-level security policy for table "Route"` (SQLSTATE 42501)
on INSERT, and zero rows on SELECT. The fix is
`storage.run({ teamId }, async () => await fn())`, and there is now a named
regression test for it.

Note which way it failed: **it denied, it did not leak.** That is the property
the whole design rests on — the extension only *grants* scope, so every failure
mode of the application code loses visibility rather than gaining it. Scope is
never derived from the query's own `where` clause, because a query that forgot
`where teamId` would then scope itself to whatever it asked for.

## Environment drift found on staging

Staging had **RLS enabled with ZERO policies on all 16 non-Relay tables**
(`User`, `Session`, `Team`, `Account`, …) while production had RLS off on the
same 16. Enabled-with-no-policy is deny-all for any non-bypass role, so
`relay_app` could not even create a `Team` fixture — the app would be dead on
staging the moment it stopped connecting as `postgres`. It is invisible while
the app connects as `postgres` (`rolbypassrls=t`), which is exactly how it
survived unnoticed.

Staging was aligned to production (RLS disabled on those 16; now 6 of 22, the
same as production) so the rehearsal is faithful. **This is flagged rather than
settled:** "RLS on `User`/`Team`/`Session` with real policies" is a defensible
end state, but it needs policies designed for it, and that is not RELAY-39.

## Supabase Realtime cannot read these tables — and this design does not change that

Stated explicitly because RELAY-7, RELAY-28 and RELAY-35 all depend on the
answer, and one has already been forced into polling by it.

The policies key on `current_setting('app.current_team_id')`, a **connection-local
GUC**. Supabase Realtime evaluates RLS per subscriber as the `authenticated`
role on its own connections, and a Realtime subscriber has no way to execute
`set_config` in that context — there is no hook for it. So the GUC is always
NULL there, `"teamId" = NULL` is never true, and Realtime sees **0 rows**. That
matches RELAY-7's independent probe (0 of 22).

RELAY-39 does **not** fix this and does not make it worse. The two are
structurally different mechanisms: this ticket sets the GUC on the *app's own
Prisma connection*, which is a path Realtime never travels. Making Realtime work
needs a **second, additive policy** for the `authenticated` role keyed on
something a JWT carries, which in turn requires bridging NextAuth identities to
Supabase Auth — the same `auth.uid()` gap RELAY-11 documented and declined to
paper over. Until someone takes that on, **treat these six tables as
Realtime-unreadable and poll.** That is a deliberate, recorded consequence of a
GUC-based policy design, not an oversight.

## What is NOT done, and exactly what is left

`DATABASE_URL` still points at `postgres`. **This is the one criterion not met,
and it is not met on purpose.** The scope must be set from the session at the
call sites, and until it is, connecting as `relay_app` makes every Relay query
return zero rows — a total outage of the product's core feature on a project now
taking real signups. The mechanism is proven; the wiring is a separate, small,
mechanical change across files that belong to other agents' tickets right now:

1. In each API route that already calls BoxyHQ's `throwIfNoTeamAccess`, wrap the
   handler body in `withTeamScope(teamMember.teamId, () => …)` using the teamId
   that check already returned. **Never a value from `req.query` or `req.body`.**
2. `models/route.ts::fetchRouteBySlugs` is the one path with no session and no
   teamId — the proxy's internal route lookup. It must become: resolve `Team` by
   slug first (`Team` has no RLS), then `withTeamScope(team.id, …)` and look the
   route up inside it. Without this, ingestion breaks.
3. The QStash consumer path takes its teamId from the signed envelope, which
   `assertRouteBelongsToTeam` already re-verifies against the database. Wrap
   after that check, not before.
4. Then set `DATABASE_URL=$RELAY_APP_DATABASE_URL` and run the suite against it.
5. `lib/nextAuth.ts:38` should take `unscopedPrisma` rather than `prisma`. The
   extended client is missing `$on`/`$use`, which `PrismaAdapter`'s nominal type
   demands; `lib/prisma.ts` currently casts to keep that file compiling and
   untouched. Nothing in the repo calls `$on`/`$use` (grepped), and the adapter
   only touches non-RLS tables, so the cast is safe — but the import is the
   right fix.

Until step 4, the six tables remain exactly what RELAY-11 left them: enforced
against every path except the app's own.
