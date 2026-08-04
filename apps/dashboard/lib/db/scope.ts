/**
 * Request-scoped tenant scope for RLS. Added in [RELAY-39].
 *
 * WHAT THIS IS FOR
 * ----------------
 * RELAY-11 put `USING ("teamId" = current_setting('app.current_team_id', true))`
 * policies on the six Relay tables. Something has to set that Postgres setting,
 * per request, from the authenticated session. This module is that something.
 *
 * WHY AsyncLocalStorage AND NOT A MODULE-LEVEL VARIABLE
 * -----------------------------------------------------
 * Node serves many requests concurrently on one process. A module-level
 * `let currentTeamId` is shared mutable state across all of them: request A sets
 * it, awaits a query, request B overwrites it, and A's query runs under B's
 * team. That is a cross-tenant read, and it is invisible in code review because
 * every individual line looks correct. AsyncLocalStorage gives each async call
 * tree its own store, so concurrent requests cannot see each other's value.
 * `__tests__/lib/rls.spec.ts` proves this with an actual concurrent test rather
 * than by inspection, because that is the only way this failure mode shows up.
 *
 * WHY THE VALUE MUST COME FROM THE SESSION
 * ----------------------------------------
 * `withTeamScope` grants access to a team's rows. If the id came from a request
 * parameter, the caller would be choosing their own tenant, which is a complete
 * authorisation bypass dressed up as row level security. The caller of this
 * function is responsible for having verified team membership first (BoxyHQ's
 * `throwIfNoTeamAccess` is the existing check); this module deliberately cannot
 * verify that itself, so the rule is stated here and enforced at the call site.
 *
 * WHAT HAPPENS IF NOBODY CALLS THIS
 * ---------------------------------
 * `current_setting('app.current_team_id', true)` returns NULL when unset, and
 * `"teamId" = NULL` is never true, so the query returns zero rows. Forgetting to
 * set the scope fails closed. That is the whole point: this module is not the
 * security boundary -- Postgres is. This module only *grants* scope. A bug here
 * can deny access; it cannot widen it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

type TenantScope = {
  /** A verified `Team.id`, taken from the server-side session. Never from input. */
  readonly teamId: string;
};

const storage = new AsyncLocalStorage<TenantScope>();

/** The six tables RELAY-11 put policies on. Everything else has no RLS. */
export const RLS_PROTECTED_MODELS: ReadonlySet<string> = new Set([
  'Route',
  'DeliveryLog',
  'DlqItem',
  'GateRule',
  'ApprovalRequest',
  'AuditLog',
]);

/**
 * Run `fn` with every Prisma query inside it scoped to `teamId`.
 *
 * `teamId` MUST be a team the caller has already been authorised for.
 *
 * Nested calls are allowed and the innermost wins, which matches the intuition
 * that a narrower scope inside a broader one is a narrowing, not a widening --
 * both values are ids the caller was already authorised for.
 */
export function withTeamScope<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
  if (typeof teamId !== 'string' || teamId.length === 0) {
    // Refusing an empty id matters: '' is a value `current_setting` returns
    // happily, and a `teamId = ''` policy check would match any row whose team
    // id was also empty. Fail loudly instead of scoping to nothing in a way
    // that looks like it worked.
    throw new Error('withTeamScope: teamId must be a non-empty string');
  }

  // `storage.run(store, async () => await fn())` -- the extra async wrapper is
  // NOT redundant, and removing it silently breaks tenant scoping.
  //
  // A Prisma client extension's `query` hook does not run when you *call*
  // `prisma.route.findMany(...)`; it runs when the returned PrismaPromise is
  // awaited. So with the naive `storage.run({ teamId }, fn)`, a caller writing
  //
  //     await withTeamScope(id, () => prisma.route.findMany({...}))
  //
  // creates the PrismaPromise inside the store but awaits it outside, and
  // AsyncLocalStorage resolves the context at continuation time. `currentTeamId()`
  // then returns undefined, no `set_config` is issued, and every query returns
  // zero rows. Measured: this exact form failed with
  // "new row violates row-level security policy for table \"Route\"" (SQLSTATE
  // 42501) on INSERT and returned 0 rows on SELECT. Awaiting inside the async
  // wrapper keeps the continuation inside the store.
  //
  // Note which way this fails: the broken form denies, it does not leak. That
  // is the property the whole design is built on, and it is why this bug showed
  // up as a loud test failure rather than as silent cross-tenant access.
  return storage.run({ teamId }, async () => await fn());
}

/** The active team id, or `undefined` outside any `withTeamScope`. */
export function currentTeamId(): string | undefined {
  return storage.getStore()?.teamId;
}

/**
 * Run `fn` with NO tenant scope, explicitly.
 *
 * Only useful inside an enclosing `withTeamScope` when a code path genuinely
 * must not inherit it. Reads on the six Relay tables will return zero rows.
 */
export function withoutTeamScope<T>(fn: () => Promise<T>): Promise<T> {
  // Same async wrapper as `withTeamScope`, for the same reason -- see there.
  return storage.exit(async () => await fn());
}
