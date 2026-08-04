import type { NextApiRequest, NextApiResponse } from 'next';
import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { fetchDlqItemsForTeam } from 'models/dlq';

/**
 * GET /api/teams/:slug/relay/dlq — every DLQ item for the team, newest first. [RELAY-8]
 *
 * Same handler shape as `relay/routes/index.ts`: `throwIfNoTeamAccess` establishes which
 * team the caller may act as, and every id used below comes from that resolved team and
 * never from the request. There is no `teamId` or `routeId` query parameter on purpose —
 * a filter the client supplies is a filter the client can change.
 *
 * The rows are shaped by `fetchDlqItemsForTeam`, which truncates payloads server-side.
 * See `DLQ_PREVIEW_MAX_CHARS` for why that cap is not left to the browser.
 */

/**
 * Hard ceiling on rows returned.
 *
 * Not pagination — pagination is a real feature and this is not it. It is a bound, so a
 * team with fifty thousand dead webhooks gets a page that renders instead of a request
 * that times out. The response says how many were returned so the UI can state plainly
 * that it is showing the newest N rather than implying it is showing everything.
 */
const MAX_ROWS = 200;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    await throwIfNoTeamAccess(req, res);

    switch (req.method) {
      case 'GET':
        await handleGET(req, res);
        break;
      default:
        res.setHeader('Allow', 'GET');
        res.status(405).json({
          error: { message: `Method ${req.method} Not Allowed` },
        });
    }
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;
    res.status(status).json({ error: { message } });
  }
}

const handleGET = async (req: NextApiRequest, res: NextApiResponse) => {
  const user = await getCurrentUserWithTeam(req, res);
  throwIfNotAllowed(user, 'team', 'read');

  const items = await fetchDlqItemsForTeam(user.team.id, MAX_ROWS);

  // No `recordMetric` here, deliberately. `AppEvent` is a closed union in `types/base.ts`
  // and has no `dlq.fetched` member; the nearest existing event, `delivery.dlq`, means "a
  // delivery just died", so emitting it on a page load would inflate the count of dead
  // webhooks every time an operator opens this page. Adding the union member is one line
  // in a file outside this ticket's boundary — noted in the dev log rather than recorded
  // wrongly here.
  res.status(200).json({ data: { items, limit: MAX_ROWS } });
};
