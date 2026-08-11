import type { NextApiResponse } from 'next';
import type { RelayEnvelope } from '@coreframe-relay/types';

import { withTeamScope } from '@/lib/db/scope';
import { forwardToDestination } from '@/lib/relay/forward';
import {
  decryptDestinationHeaders,
  DestinationHeadersKeyError,
  DestinationHeadersTamperError,
} from '@/lib/relay/destinationAuth';
import { recordMetric } from '@/lib/metrics';
import {
  assertRouteBelongsToTeam,
  recordDeliveryAttempt,
} from 'models/delivery';
import { recordDlqItem } from 'models/dlq';
import { fetchRouteForDelivery } from 'models/route';

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
    // ── [RELAY-59] Decrypt the customer-configured destination auth headers. ──────
    //
    // The route row, not the envelope, is the source. The envelope's `destination`
    // was pinned at ingestion; the AUTH config lives on the route and may have been
    // changed since. This read is already inside `withTeamScope`, so a route whose
    // headers were edited mid-flight to belong elsewhere yields nothing.
    //
    // Failure mode: if decryption cannot be completed — key gone, tampered ciphertext
    // — the responsible thing is to record a FAILED row and NOT POST a half-authenticated
    // payload a destination may then trust. Loud on purpose; the alternative is
    // silently forwarding without auth and the destination handing the customer a log
    // of unauthenticated POSTs misattributed to them.
    let destinationHeaders: Record<string, string> = {};
    {
      const route = await fetchRouteForDelivery(teamId, routeId);
      const stored = route?.destinationHeadersEncrypted ?? null;
      if (stored) {
        try {
          destinationHeaders = decryptDestinationHeaders(stored);
        } catch (error) {
          // A tamper is recorded FAILED, not retried — a tampered row will not
          // magically decrypt on the next attempt, and 5xx invites QStash to keep
          // retrying a failure it cannot help with.
          if (error instanceof DestinationHeadersTamperError) {
            await recordDeliveryAttempt({
              teamId,
              routeId,
              requestId,
              status: 'FAILED',
              attemptCount,
              responseCode: null,
              latencyMs: null,
              payloadSizeB,
              deliveredAt: null,
              isTest,
            });
            console.error('[relay] qstash: destination headers tampered or key changed', {
              requestId,
            });
            // 200 on purpose: this is OUR failure, not QStash's or the destination's,
            // and a non-2xx would drive retries that achieve nothing.
            return res.status(200).json({ status: 'failed', requestId });
          }
          if (error instanceof DestinationHeadersKeyError) {
            // Misconfigured deploy. 500 is correct: another attempt once the env is
            // fixed is the right behaviour.
            throw error;
          }
          throw error;
        }
      }
    }

    const outcome = await forwardToDestination({
      destination,
      headers,
      body,
      requestId,
      // Propagated so the RELAY-66 smoke waiver in forward.ts fires ONLY for
      // test-marked traffic; real webhooks keep the full SSRF rejection path.
      isTest,
      // Decrypted only now, only here, only for this request. Never stored, never logged.
      destinationHeaders,
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
