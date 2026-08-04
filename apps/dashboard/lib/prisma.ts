import { PrismaClient } from '@prisma/client';

import { withTeamScopeExtension } from '@/lib/db/scoped-client';

/**
 * [RELAY-39] The Prisma client, extended so that queries against the six
 * RLS-protected Relay tables carry the caller's team scope into Postgres.
 *
 * READ `docs/rls.md` BEFORE CHANGING ANY OF THIS. The short version:
 *
 * 1. RELAY-11 put `USING ("teamId" = current_setting('app.current_team_id',
 *    true))` policies on six tables and FORCED RLS. Those policies were inert,
 *    because the app connected as `postgres`, which carries `rolbypassrls=t`.
 * 2. RELAY-39 gave `relay_app` (rolsuper=f, rolbypassrls=f) LOGIN and grants on
 *    all 22 tables so it can be the runtime role.
 * 3. This file is step 3: setting `app.current_team_id` per query.
 *
 * WHY `SET LOCAL` AND NOT `SET`
 * -----------------------------
 * Measured on the hosted project through Supavisor in transaction pooling mode
 * (`:6543`), as `relay_app`:
 *
 *   * One client issued a plain `SET app.current_team_id = 'LEAKED-FROM-CLIENT-1'`
 *     and disconnected. Five subsequent, entirely separate client connections
 *     then read that same value back -- 5 of 5. A session-level `SET` is pinned
 *     to the pooled *server* connection, not to the client, so it outlives the
 *     client that set it and is handed to whoever gets that connection next.
 *     On a tenant-scoping setting that is a cross-tenant read.
 *   * `set_config('app.current_team_id', $1, true)` (the function form of
 *     `SET LOCAL`) inside an explicit transaction returned the value correctly
 *     inside the transaction and NULL immediately after COMMIT, with no
 *     leakage to any later connection.
 *
 * So the scope is applied as a transaction-local setting, and the query that
 * depends on it must be in the same transaction. That is what the extension
 * below does: `$transaction([set_config, query])` is a single Prisma batch
 * transaction, which Prisma issues as BEGIN / ... / COMMIT on ONE connection.
 * Through a transaction-mode pooler, one transaction is exactly the unit that
 * gets pinned to one server connection, so this is safe on the pooler and not
 * merely safe on local Postgres.
 *
 * WHY THIS EXTENSION IS NOT THE SECURITY BOUNDARY
 * -----------------------------------------------
 * Postgres is. This extension only *grants* scope. If it fails to run, or
 * `currentTeamId()` is undefined, no setting is made, `current_setting` returns
 * NULL, `"teamId" = NULL` is never true, and the query returns zero rows. Every
 * failure mode of this file denies access; none of them widen it. In particular
 * the scope is NEVER derived from the query's own `where` clause -- if it were,
 * a query that forgot `where teamId` would scope itself to whatever it happened
 * to ask for, which is the exact bug RELAY-39 exists to close.
 *
 * COST
 * ----
 * One extra round trip and a BEGIN/COMMIT per query on the six protected
 * tables. Measured numbers are in `docs/rls.md`. Queries on the other 16 tables
 * (NextAuth's `Session`/`User`, teams, billing) are not wrapped at all and pay
 * nothing, which is why the extension checks `RLS_PROTECTED_MODELS` rather than
 * wrapping every model unconditionally.
 */

declare global {
  // allow global `var` declarations
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

const basePrisma =
  global.prisma ||
  new PrismaClient({
    //log: ["error"],
  });

if (process.env.NODE_ENV !== 'production') {
  global.prisma = basePrisma;
}

/**
 * The un-extended client.
 *
 * Exported for the two things that legitimately need it: `$connect`/`$disconnect`
 * lifecycle, and raw diagnostic queries in the RLS test suite. Application code
 * should use `prisma`. Using this for model queries silently opts out of team
 * scoping -- which, note, means zero rows on the six protected tables, not extra
 * rows.
 */
export const unscopedPrisma = basePrisma;

/**
 * The client every call site should use.
 *
 * ON THE CAST
 * -----------
 * `$extends` returns a `DynamicClientExtensionThis`, which is structurally a
 * PrismaClient minus `$on` and `$use` (both deprecated, both removed on extended
 * clients). `lib/nextAuth.ts` passes this client straight into NextAuth's
 * `PrismaAdapter`, whose signature demands a nominal `PrismaClient`, so without
 * the cast the build fails with:
 *
 *   TS2345: ... is missing the following properties from type 'PrismaClient':
 *   $on, $use            (lib/nextAuth.ts:38)
 *
 * The cast is safe here for a checked reason, not an assumed one: `$on` and
 * `$use` have zero call sites in this repo (grepped across apps/ and packages/),
 * and the PrismaAdapter only ever calls model methods on `User`, `Session`,
 * `Account` and `VerificationToken` -- none of which are RLS-protected, so the
 * extension is a pass-through for every query the adapter makes.
 *
 * The honest alternative was to change `lib/nextAuth.ts` to take
 * `unscopedPrisma`, which is a cleaner fix and is what should happen when that
 * file is next touched. It is outside RELAY-39's file boundary, so it is
 * recorded in docs/rls.md as follow-up rather than done here.
 */
export const prisma = withTeamScopeExtension(
  basePrisma
) as unknown as PrismaClient;
