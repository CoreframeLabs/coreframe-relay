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
 *   RELAY-1 (now)  — writes a structured line via the logger. No database dependency,
 *                    so the dashboard boots before any Relay migration exists.
 *   RELAY-2 (next) — the `AuditLog` Prisma model lands and `persist()` below starts
 *                    writing rows. Not one call site changes.
 *
 * Keeping the seam means the events are never silently dropped in the meantime: an
 * un-persisted audit event still appears in the logs, which is recoverable. Deleting the
 * calls and "adding audit later" is how an audit trail ends up with a hole in it.
 */

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
 * Persist one audit event.
 *
 * RELAY-2 replaces the body with a `prisma.auditLog.create(...)`. The signature and the
 * failure contract below are the parts call sites depend on, so both are fixed now.
 */
async function persist(entry: AuditEvent): Promise<void> {
  // `auditEvent`, not `event`: spreading `entry` last would otherwise overwrite the log
  // discriminator with the audited event name, and every audit line would be
  // indistinguishable from any other log line at the same level.
  // eslint-disable-next-line no-console
  console.info(
    JSON.stringify({
      level: 'info',
      event: 'audit.recorded',
      ts: new Date().toISOString(),
      teamId: entry.teamId,
      auditEvent: entry.event,
      actor: entry.actor ?? null,
      target: entry.target ?? null,
      metadata: entry.metadata ?? {},
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
