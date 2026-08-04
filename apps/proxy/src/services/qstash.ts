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

  const callback = new URL(QSTASH_CALLBACK_PATH, dashboard).toString();
  const publishUrl = `${base.replace(/\/+$/, '')}/v2/publish/${callback}`;

  let res: Response;
  try {
    res = await fetch(publishUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        // The route's own retry budget, not a global default. Bounded 1..10 by the
        // contract schema; QStash clamps to the account plan's own ceiling above that.
        'Upstash-Retries': String(envelope.maxRetries),
        // Reaches the consumer as `relay-request-id`, which is how one webhook is
        // correlated across proxy → QStash → consumer → DeliveryLog row.
        [`Upstash-Forward-${RELAY_REQUEST_ID_HEADER}`]: envelope.requestId,
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
  try {
    const body = (await res.json()) as { messageId?: string };
    return { ok: true, messageId: body.messageId ?? null };
  } catch {
    return { ok: true, messageId: null };
  }
}
