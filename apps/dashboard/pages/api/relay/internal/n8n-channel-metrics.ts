import type { NextApiRequest, NextApiResponse } from 'next';

import { isAuthorizedInternalRequest } from '@/lib/relay/internalAuth';
import { getN8nChannelMetrics } from 'models/n8nChannelMetrics';

/**
 * GET /api/relay/internal/n8n-channel-metrics   — [RELAY-68]
 * Authorization: Bearer {RELAY_API_SECRET}
 *
 * Internal-only reporting endpoint: how many paying customers and how much MRR came
 * specifically through the n8n channel (RELAY-70's UTM-tagged marketing content),
 * for the 90-day n8n-wedge goal (3-5 paying customers acquired specifically through
 * the n8n channel by 2026-11-17). Not proxy-facing traffic like route-lookup.ts, but
 * still a non-browser, non-session caller with no team/user context of its own — so
 * it reuses that same bearer-secret pattern (constant-time compare, fail closed on
 * an unset secret, fixed error bodies) rather than inventing a second one for the
 * same problem.
 *
 * See pages/api/relay/internal/route-lookup.ts for why this endpoint must be listed
 * BY EXACT PATH in middleware.ts's unauthenticated allowlist, not by wildcard: a
 * wildcard on /api/relay/internal/* would silently un-authenticate any future file
 * dropped into that directory.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'bad_request' });
  }

  if (!isAuthorizedInternalRequest(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const metrics = await getN8nChannelMetrics();

    // Same reasoning as route-lookup.ts: this is tenant/business data derived from
    // it and must never sit in a shared or intermediary cache.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(metrics);
  } catch (error) {
    console.error('[relay] n8n-channel-metrics failed', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    return res.status(500).json({ error: 'internal_error' });
  }
}
