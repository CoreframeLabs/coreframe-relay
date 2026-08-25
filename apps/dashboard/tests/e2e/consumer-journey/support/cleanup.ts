import { prisma } from '@/lib/prisma';

/**
 * Targeted teardown — deletes ONLY the rows this suite's own run created, scoped by
 * the exact email/team-slug this run generated (see `testData.ts`).
 *
 * Deliberately NOT `tests/e2e/support/account.teardown.ts`'s pattern
 * (`prisma.team.deleteMany()` / `prisma.user.deleteMany()` with no `where` at all —
 * every Team and User row in the local DB, run or not run by this suite). That is
 * safe for the SSO/settings suites because their `setup` project always recreates
 * the one fixed `jackson@example.com` fixture before every run, but this suite
 * creates unique, timestamped data on every run and must leave everyone else's local
 * dev data — including rows created moments earlier by another agent working in a
 * sibling worktree against the same shared local Postgres — untouched.
 *
 * `Team.delete` cascades (prisma/schema.prisma: `onDelete: Cascade`) through
 * TeamMember → Route → DeliveryLog/DlqItem, so deleting the Team is sufficient for
 * everything this suite wrote under it. `User.delete` separately cascades Session
 * and any TeamMember row not already gone via the Team cascade. Both are
 * `deleteMany` with an exact `where`, not `delete`, so a partially-failed run (one
 * that never reached signup, or reached it but not route creation) tears down
 * cleanly instead of throwing "record not found".
 */
export async function cleanupJourneyData(params: { email: string; teamSlug: string }) {
  await prisma.team.deleteMany({ where: { slug: params.teamSlug } });
  await prisma.user.deleteMany({ where: { email: params.email } });
}
