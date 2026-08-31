import type { NextApiResponse } from 'next';
import type { RelayEnvelope } from '@coreframe-relay/types';

import { withTeamScope } from '@/lib/db/scope';
import { filterForwardHeaders, forwardToDestination } from '@/lib/relay/forward';
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
import { notifyDlqFallback } from '@/lib/relay/dlqNotify';

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

  const retriesSoFar =
    Number.isFinite(retriedRaw) && retriedRaw >= 0 ? retriedRaw : 0;
  const attemptCount = retriesSoFar + 1;
  const isFinalAttempt = retriesSoFar >= maxRetries;

  const payloadSizeB = Buffer.byteLength(body, 'utf8');

  // Tenant check BEFORE the outbound request, not after. See the comment in the
  // original qstash handler — a cross-tenant envelope was POSTing to the destination
  // before failing with a 500, and 500 meant "retry" to QStash.
  //
  // ── [RELAY-84] WHY THIS ASSERT IS ITSELF SCOPED ──────────────────────────────────
  //
  // This read USED to run outside any scope, and that was the single most damaging
  // unwrapped call site in the Relay path — worse than any of the six dashboard
  // handlers, because it breaks delivery rather than a page. MEASURED under
  // `relay_app` (rolbypassrls=f): `assertRouteBelongsToTeam` on a VALID (teamId,
  // routeId) pair throws `Route not found.` when unscoped, and succeeds when scoped.
  // Unscoped, the policy sees NULL, the lookup finds nothing, the `catch` below fires,
  // and this function answers 400 `bad_request` — which QStash reads as permanent, so
  // it does not retry. After the G2a flip that is EVERY delivery rejected at the
  // consumer, with no DeliveryLog row and no DlqItem, while the proxy has already
  // told the customer 200 at ingest. A total, silent delivery outage.
  //
  // Scoping to `teamId` here does NOT weaken the check, which is the only reason it is
  // allowed to be the envelope's unverified claim. The query is
  // `where: { id: routeId, teamId }` — the RLS predicate the scope adds is
  // `"teamId" = <claim>`, textually the same constraint the WHERE already carries. It
  // is redundant, so it cannot surface a row the unscoped form would not have. The
  // assert's actual job survives intact: an envelope pairing team X with team Y's
  // route still finds nothing, because `WHERE teamId = X` excludes it no matter what
  // the scope says.
  //
  // What must NOT move is the ORDERING. Everything that WRITES still happens inside
  // the second `withTeamScope` below, entered only after the database has confirmed
  // the pair. Scope-then-verify would be scoping on a claim in order to trust it;
  // this is scoping a query that already constrains itself to the same value.
  try {
    await withTeamScope(teamId, () =>
      assertRouteBelongsToTeam(teamId, routeId)
    );
  } catch {
    console.error('[relay] qstash: envelope route/team pair does not exist', {
      requestId,
    });
    return res.status(400).json({ error: 'bad_request' });
  }

  // [RELAY-39 wiring — docs/rls.md step 3] The envelope's teamId is the caller's
  // claim; `assertRouteBelongsToTeam` above is the database's word that the pair
  // belongs together. The scope that guards the WRITES is established only AFTER
  // that word, never before.
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
            console.error(
              '[relay] qstash: destination headers tampered or key changed',
              {
                requestId,
              }
            );
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
        const dlqFailReason = outcome.failReason ?? 'delivery failed';

        const { duplicate } = await recordDlqItem({
          teamId,
          routeId,
          requestId,
          failReason: dlqFailReason,
          attemptCount,
          body,
          // [RELAY-65] The headers of the attempt that failed for the last time.
          // Dropping them here — as this call used to — is the root cause of RELAY-65:
          // a manual Retry had no headers to replay, so a destination verifying
          // `stripe-signature` / `x-hub-signature-256` / `x-shopify-hmac-sha256`
          // rejected every retried delivery.
          //
          // FILTERED BEFORE STORAGE, not stored raw. `forwardToDestination` above applies
          // `filterForwardHeaders` internally, so this is exactly the set that just went
          // on the wire — persisting anything WIDER would write bytes we would never
          // resend. That matters because the proxy's inbound strip list
          // (`STRIPPED_HEADERS` in apps/proxy/src/routes/ingest.ts) is NARROWER than this
          // deny-list: `x-api-key`, `set-cookie`, `www-authenticate` and the `proxy-*`
          // family survive ingest but are refused at forward time. Storing the raw map
          // would park a sender's `x-api-key` in a JSONB column for the whole retention
          // window to no purpose — nothing reads these except a replay, and a replay
          // re-filters them anyway. Persist only what is replayable.
          //
          // `filterForwardHeaders` is a DENY-list, so this narrows nothing that matters:
          // vendor signature headers are precisely what it is built never to strip.
          headers: filterForwardHeaders(headers),
        });

        if (!isTest) recordMetric('delivery.dlq');

        // [RELAY-48] Awaited, not fire-and-forget — a Vercel function can be frozen
        // the instant the response is sent, and an un-awaited promise here would race
        // that freeze and might never actually send. `notifyDlqFallback` swallows every
        // error itself (see its own doc comment), so awaiting it can never turn this
        // successful DLQ write into a 500 QStash would retry against a destination
        // already given up on — it can only add latency, never fail this response.
        // Skipped for a duplicate write (the item already existed, so a notification for
        // it already fired once) and for `isTest` traffic (the "Send test webhook"
        // button should not email a real team owner — same exclusion `recordMetric`
        // already applies a few lines up).
        if (!isTest && !duplicate) {
          await notifyDlqFallback({
            teamId,
            routeId,
            requestId,
            failReason: dlqFailReason,
          });
        }

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
