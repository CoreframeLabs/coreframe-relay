/**
 * [RELAY-39] The Prisma extension that carries the request's team scope into
 * Postgres, so RELAY-11's RLS policies have something to evaluate.
 *
 * The rationale, the pooler measurements, and the reason this is a batch
 * transaction rather than an interactive one are all documented on
 * `lib/prisma.ts` and in `docs/rls.md`. This file exists separately from
 * `lib/prisma.ts` for exactly one reason: `lib/prisma.ts` builds its client from
 * `DATABASE_URL`, and the RLS test suite has to drive the same extension against
 * a deliberately different connection (the `relay_app` credential) to prove the
 * runtime role does not bypass RLS. A factory makes that possible without the
 * test reaching into module internals or mutating `process.env`.
 */

import { PrismaClient, Prisma } from '@prisma/client';

import { RLS_PROTECTED_MODELS, currentTeamId } from '@/lib/db/scope';

/**
 * Wrap `client` so that operations on the six RLS-protected models run inside a
 * transaction that first sets `app.current_team_id` to the ambient scope.
 *
 * Returns an extended client. The original is unchanged and remains usable for
 * `$connect`/`$disconnect` and raw queries.
 */
export function withTeamScopeExtension<T extends PrismaClient>(client: T) {
  return client.$extends({
    name: 'relay-rls-team-scope',
    query: {
      $allModels: {
        async $allOperations({ model, args, query }) {
          const teamId = currentTeamId();

          // No ambient scope, or a table with no RLS policy on it: run as-is.
          // An unscoped query against a protected table is still safe -- the
          // policy sees NULL and returns zero rows -- and this keeps NextAuth's
          // per-request session lookups out of a transaction they do not need.
          if (teamId === undefined || !RLS_PROTECTED_MODELS.has(model)) {
            return query(args);
          }

          // `Prisma.sql` binds `teamId` as a parameter; it is never concatenated
          // into SQL text. The third argument to set_config is `is_local` --
          // this is the function form of SET LOCAL, which is what makes it safe
          // through a transaction-mode pooler.
          const setScope = client.$executeRaw(
            Prisma.sql`SELECT set_config('app.current_team_id', ${teamId}, true)`
          );

          // Batch transaction, not interactive. See lib/prisma.ts.
          const [, result] = await client.$transaction([setScope, query(args)]);

          return result;
        },
      },
    },
  });
}

export type ScopedPrismaClient = ReturnType<typeof withTeamScopeExtension>;

/**
 * Build a fresh scoped client against an explicit connection string.
 *
 * Used by the RLS test suite, which must connect as `relay_app` regardless of
 * what `DATABASE_URL` currently points at. Application code should import
 * `prisma` from `lib/prisma` instead -- this opens a new connection pool every
 * time it is called.
 */
export function createScopedPrismaClient(datasourceUrl: string) {
  const client = new PrismaClient({ datasourceUrl });
  return { base: client, scoped: withTeamScopeExtension(client) };
}
