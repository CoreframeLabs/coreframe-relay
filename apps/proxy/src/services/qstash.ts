/**
 * Upstash QStash publisher — [RELAY-4].
 *
 * Plain `fetch`, not `@upstash/qstash`. The SDK exists to wrap two headers and a URL, and
 * every dependency added to a Worker is bundle size on a hot path that must answer in
 * single-digit milliseconds. This is the whole surface we need.
 *
 * Wire shape, from Upstash's REST documentation:
 *
 *   POST {UPSTASH_QSTASH_URL}/v2/publish/{destination-url}
 *   Authorization: Bearer {UPSTASH_QSTASH_TOKEN}
 *   Content-Type: application/json
 *   Upstash-Retries: {n}
 *   Upstash-Forward-{name}: {value}   → arrives at the destination as `{name}: {value}`
 *
 * The destination URL is appended to the path unencoded — that is what the documented
 * curl example does, and encoding it produces a 400 from QStash.
 */
import { RELAY_REQUEST_ID_HEADER } from '../../../../packages/types/src/internal';
import type { RelayEnvelope } from '@coreframe-relay/types';
import type { Bindings } from '../types/bindings.js';

export type PublishResult =
  | { ok: true; messageId: string | null }
  | { ok: false; code: 'not_configured' | 'rejected' | 'unreachable'; status?: number };

/**
 * Where QStash delivers the envelope: the dashboard consumer ([RELAY-5]).
 *
 * Note what is NOT here — the customer's own destination. QStash is handed our consumer,
 * and the consumer does the outbound call after re-validating the destination against the
 * SSRF blocklist. Publishing straight at the customer destination would move retries and
 * delivery logging outside anything we can observe.
 */
export const QSTASH_CALLBACK_PATH = '/api/relay/qstash';

/**
 * [RELAY-50] Local-only queue replacement for `wrangler dev`. Upstash's callback
 * requires a public URL, and a `localhost` destination is rejected with
 * "endpoint resolves to a loopback address" — the leg of the pipeline the public
 * internet can never prove locally. When `RELAY_LOCAL_QUEUE_URL` is bound (dev only),
 * the envelope is POSTed straight to the dashboard's consumer over plain fetch, with
 * the request-id header forwarded, and the function returns as if QStash had accepted
 * it. The consumer treats every request it receives as verified regardless of how it
 * arrived, which is precisely why this binding is never present in a deployed env.
 */
export const RELAY_LOCAL_QUEUE_PATH = '/api/relay/qstash-test';

/** Ceiling on how long a publish may take before the ack path gives up. */
const PUBLISH_TIMEOUT_MS = 5_000;

export async function publishToQStash(
  env: Bindings,
  envelope: RelayEnvelope
): Promise<PublishResult> {
  const base = env.UPSTASH_QSTASH_URL;
  const token = env.UPSTASH_QSTASH_TOKEN;
  const dashboard = env.RELAY_DASHBOARD_URL;

  if (!base || !token || !dashboard) return { ok: false, code: 'not_configured' };

  // [RELAY-50] Local-only queue: cut out Upstash, deliver straight to the dashboard.
  // The header and body shape below matches what the consumer would get from QStash
  // (relay-request-id arrives via `Upstash-Forward-…`, so here it is set directly),
  // which keeps the handler agnostic about which of its callers is real.
  const localQueue = env.RELAY_LOCAL_QUEUE_URL;
  const callback = localQueue
    ? new URL(RELAY_LOCAL_QUEUE_PATH, dashboard).toString()
    : new URL(QSTASH_CALLBACK_PATH, dashboard).toString();
  const publishUrl = localQueue
    ? callback
    : `${base.replace(/\/+$/, '')}/v2/publish/${callback}`;

  let res: Response;
  try {
    res = await fetch(publishUrl, {
      method: 'POST',
      headers: {
        // The real QStash path authenticates with the Upstash token above; the local
        // loop instead needs `RELAY_API_SECRET`, because `qstash-test.ts` (the endpoint
        // this branch calls) unconditionally requires `Bearer <RELAY_API_SECRET>` and
        // 401s without it — the same secret/header shape `routeLookup.ts` already uses
        // for every other proxy → dashboard internal call. [RELAY-112]
        authorization: localQueue ? `Bearer ${env.RELAY_API_SECRET ?? ''}` : `Bearer ${token}`,
        'content-type': 'application/json',
        ...(localQueue
          ? {}
          : {
              // The route's own retry budget, not a global default. Bounded 1..10 by
              // the contract schema; QStash clamps to the account plan's ceiling above
              // that. The local loop skips retries entirely: the point of the button
              // is an immediate answer, not a retry budget spent against a local server.
              'Upstash-Retries': String(envelope.maxRetries),
            }),
        // Reaches the consumer as `relay-request-id`, which is how one webhook is
        // correlated across proxy → QStash → consumer → DeliveryLog row.
        ...(localQueue
          ? { [RELAY_REQUEST_ID_HEADER]: envelope.requestId }
          : { [`Upstash-Forward-${RELAY_REQUEST_ID_HEADER}`]: envelope.requestId }),
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'unreachable' };
  }

  if (!res.ok) {
    return { ok: false, code: 'rejected', status: res.status };
  }

  // Measured against the live API: a successful publish answers **201**, not 200, with
  // `{ messageId: "msg_..." }`. Hence the `res.ok` range check above rather than a
  // `=== 200`. The id is useful in logs, but the ack does not depend on parsing it — the
  // message is durable the moment QStash returns 2xx.
  //
  // On the local loop (`RELAY_LOCAL_QUEUE_URL` bound) the consumer answers 200 with
  // its own body — `messageId` here is a sentinel, not a QStash id, and the distinction
  // only matters for log correlation, which this deliberately does not claim to be.
  try {
    const body = (await res.json()) as { messageId?: string };
    return { ok: true, messageId: localQueue ? (body.messageId ?? 'local') : body.messageId ?? null };
  } catch {
    return { ok: true, messageId: localQueue ? 'local' : null };
  }
}
