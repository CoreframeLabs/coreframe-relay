/**
 * Relay audit trail — replaces BoxyHQ's Svix event emission.
 *
 * BoxyHQ shipped Svix to push team lifecycle events out to customer webhook endpoints.
 * Relay IS the webhook layer, so Svix is a direct competitor and was stripped in
 * [RELAY-1] (see growth/product/relay-boilerplate-integration.md, Part 1 and Part 6).
 *
 * What the events were actually being used for is an audit trail, so that is what this
 * module provides. It is deliberately a thin seam with a stable signature:
 *
 *   RELAY-1 — wrote a structured log line. No database dependency, so the dashboard
 *             booted before any Relay migration existed.
 *   RELAY-2 — the `AuditLog` model landed and `persist()` now writes rows. Not one call
 *             site changed, which is what the seam was for.
 *
 * Keeping the seam meant the events were never silently dropped in between: an
 * un-persisted audit event still appeared in the logs, which is recoverable. Deleting the
 * calls and "adding audit later" is how an audit trail ends up with a hole in it.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withTeamScope } from '@/lib/db/scope';
import type { AppEvent } from 'types';

/** Actor is nullable: some events (invitation accepted) are triggered by a non-member. */
export type AuditEvent = {
  teamId: string;
  event: AppEvent;
  actor?: string | null;
  target?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Persist one audit event to the `AuditLog` table.
 *
 * [RELAY-2] swapped this body from a log line to a real row, exactly as [RELAY-1]
 * planned. Not one call site changed — that was the point of the seam.
 *
 * [RELAY-39 G2a follow-up, found 2026-08-25] `AuditLog` is one of the six
 * RLS_PROTECTED_MODELS (lib/db/scope.ts) — since the `DATABASE_URL` flip to `relay_app`,
 * an unscoped write here hits Postgres RLS deny-all (`42501: new row violates row-level
 * security policy for table "AuditLog"`), confirmed live via Vercel's runtime-error
 * tracking on `/api/auth/join`'s `team.created` event. `recordAuditEvent()` never throws
 * by design, so this failed silently — no 500, just a permanently missing audit row —
 * since the flip landed. Every `AuditEvent` already carries `teamId`, so the fix is one
 * `withTeamScope` wrap here rather than hunting down and fixing every one of this
 * function's many call sites individually (team creation, invitations, members, routes,
 * …) — the seam this module documents above is exactly what makes a single-point fix
 * possible.
 */
async function persist(entry: AuditEvent): Promise<void> {
  await withTeamScope(entry.teamId, () =>
    prisma.auditLog.create({
      data: {
        teamId: entry.teamId,
        // The column is a plain string, not an enum: audit events outlive the AppEvent
        // union (route_created, payload_approved, …) and a migration should not be the
        // cost of recording a new kind of event.
        event: entry.event,
        // "system" rather than null for machine-initiated events — the column is NOT NULL
        // and an unattributed row is worse than an explicitly attributed one.
        actor: entry.actor ?? 'system',
        target: entry.target ?? null,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
      },
    })
  );
}

/**
 * Record an audit event.
 *
 * **Never throws.** An audit write must not be able to fail the user-facing operation
 * that triggered it — a team invitation that 500s because the audit sink is down is a
 * worse outcome than an audit line that is missing and logged as missing. This mirrors
 * the old Svix behaviour, which no-op'd whenever the integration was unconfigured.
 */
export async function recordAuditEvent(entry: AuditEvent): Promise<void> {
  try {
    await persist(entry);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'audit.write_failed',
        ts: new Date().toISOString(),
        teamId: entry.teamId,
        auditEvent: entry.event,
        reason: error instanceof Error ? error.message : String(error),
      })
    );
  }
}
