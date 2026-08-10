import type { NextApiResponse } from 'next';
import type { RelayEnvelope } from '@coreframe-relay/types';

import { withTeamScope } from '@/lib/db/scope';
import { forwardToDestination } from '@/lib/relay/forward';
import { recordMetric } from '@/lib/metrics';
import {
  assertRouteBelongsToTeam,
  recordDeliveryAttempt,
} from 'models/delivery';
import { recordDlqItem } from 'models/dlq';

/**
 * The pipeline's delivery half, extracted from `pages/api/relay/qstash.ts` so the same
 * code runs whether the envelope arrives via QStash (production) or via the local-only
 * `qstash-test` endpoint the proxy uses when `RELAY_LOCAL_QUEUE_URL` is bound. The
 * behavior MUST NOT diverge between the two callers — that is the promise the button
 * exists to prove.
 *
 * This function deliberately knows nothing about authentication: the caller has already
 * run QStash's signature check (production) or decided it is fine (local dev), so its
 * only inputs are the raw, already-validated envelope plus the retry counters.
 */
export async function consumeEnvelope(
  envelope: RelayEnvelope,
  retriedRaw: number,
  res: NextApiResponse
) {
  const {
    requestId,
    routeId,
    teamId,
    destination,
    maxRetries,
    headers,
    body,
    // Default is defensive, kept in code rather than relying on the schema having
    // already populated it: an envelope that reached here without being parsed by
    // RelayEnvelopeSchema (a reproducer, an integration test, a future caller)
    // defaults to REAL, never to TEST — the bias that makes a forged test marker
    // count as real traffic, never the other way around.
    isTest = false,
  } = envelope;

  const retriesSoFar = Number.isFinite(retriedRaw) && retriedRaw >= 0 ? retriedRaw : 0;
  const attemptCount = retriesSoFar + 1;
  const isFinalAttempt = retriesSoFar >= maxRetries;

  const payloadSizeB = Buffer.byteLength(body, 'utf8');

  // Tenant check BEFORE the outbound request, not after. See the comment in the
  // original qstash handler — a cross-tenant envelope was POSTing to the destination
  // before failing with a 500, and 500 meant "retry" to QStash.
  try {
    await assertRouteBelongsToTeam(teamId, routeId);
  } catch {
    console.error('[relay] qstash: envelope route/team pair does not exist', {
      requestId,
    });
    return res.status(400).json({ error: 'bad_request' });
  }

  // [RELAY-39 wiring — docs/rls.md step 3] The envelope's teamId is the caller's
  // claim; `assertRouteBelongsToTeam` above is the database's word that the pair
  // belongs together. Scope is established only AFTER that word, never before —
  // done on the claim and the claim is the scope, which is exactly what the
  // assert exists to stop.
  return withTeamScope(teamId, async () => {
    const outcome = await forwardToDestination({
      destination,
      headers,
      body,
      requestId,
    });

    try {
      const status = outcome.ok
        ? 'DELIVERED'
        : isFinalAttempt
          ? 'DLQ'
          : 'RETRYING';

      // [RELAY-50] `isTest` is recorded alongside the state so the badge and the
      // billing exclusion read the same field. It is NOT in the metric call below:
      // the metrics pipeline is the billing counter's substrate ([RELAY-12] will read
      // from `DeliveryLog.isTest`), and counting test sends here would inflate it.
      await recordDeliveryAttempt({
        teamId,
        routeId,
        requestId,
        status,
        attemptCount,
        responseCode: outcome.responseCode,
        latencyMs: outcome.latencyMs,
        payloadSizeB,
        deliveredAt: outcome.ok ? new Date() : null,
        isTest,
      });

      if (outcome.ok) {
        if (!isTest) recordMetric('delivery.delivered');
        return res.status(200).json({ status: 'delivered', requestId });
      }

      if (isFinalAttempt) {
        await recordDlqItem({
          teamId,
          routeId,
          requestId,
          failReason: outcome.failReason ?? 'delivery failed',
          attemptCount,
          body,
        });

        if (!isTest) recordMetric('delivery.dlq');
        return res.status(200).json({ status: 'dlq', requestId });
      }

      if (!isTest) recordMetric('delivery.retrying');
      return res.status(502).json({ status: 'retrying', requestId });
    } catch (error) {
      console.error('[relay] qstash: failed to record delivery', {
        requestId,
        name: error instanceof Error ? error.name : 'unknown',
      });
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}
