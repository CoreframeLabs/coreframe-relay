import env from '@/lib/env';
import { throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiError } from '@/lib/errors';
import { dsyncManager } from '@/lib/jackson/dsync';
import { sendAudit } from '@/lib/retraced';
import { throwIfNoAccessToDirectory } from '@/lib/guards/team-dsync';

const dsync = dsyncManager();

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { method } = req;

  try {
    if (!env.teamFeatures.dsync) {
      throw new ApiError(404, 'Not Found');
    }

    switch (method) {
      case 'GET':
        await handleGET(req, res);
        break;
      case 'PATCH':
        await handlePATCH(req, res);
        break;
      case 'DELETE':
        await handleDELETE(req, res);
        break;
      default:
        res.setHeader('Allow', 'GET, PATCH, DELETE');
        res.status(405).json({
          error: { message: `Method ${method} Not Allowed` },
        });
    }
  } catch (error: any) {
    console.error(error);

    const message = error.message || 'Something went wrong';
    const status = error.status || 500;

    res.status(status).json({ error: { message } });
  }
}

const handleGET = async (req: NextApiRequest, res: NextApiResponse) => {
  const teamMember = await throwIfNoTeamAccess(req, res);

  throwIfNotAllowed(teamMember, 'team_dsync', 'read');

  const directoryId = req.query.directoryId as string;

  await throwIfNoAccessToDirectory({
    teamId: teamMember.team.id,
    directoryId,
  });

  const connection = await dsync.getConnectionById(directoryId);

  res.status(200).json(connection);
};

const handlePATCH = async (req: NextApiRequest, res: NextApiResponse) => {
  const teamMember = await throwIfNoTeamAccess(req, res);

  // [security-audit 2026-09-16] `update`, not `read`: this handler writes. Same
  // effective gate today (MEMBER holds no `team_dsync` action at all; ADMIN/OWNER
  // hold `*`), but the action string is what the permission table is keyed on and
  // a future narrowing of ADMIN to read-only would otherwise leave this write open.
  throwIfNotAllowed(teamMember, 'team_dsync', 'update');

  const directoryId = req.query.directoryId as string;

  await throwIfNoAccessToDirectory({
    teamId: teamMember.team.id,
    directoryId,
  });

  // [security-audit 2026-09-16] The guard above validated the URL's `directoryId`.
  // The previous `{ ...req.query, ...req.body }` spread let a `directoryId` key in
  // the JSON body override the one the guard checked, so `updateConnection` would
  // write to whatever directory the BODY named — including another team's — with
  // jackson's `directories.update` applying `webhook_url`, `webhook_secret`,
  // `deactivated`, etc. to it. The validated id is now pinned LAST so nothing in
  // the body can displace it.
  const body = { ...req.body, ...req.query, directoryId };

  const connection = await dsync.updateConnection(body);

  res.status(200).json(connection);
};

const handleDELETE = async (req: NextApiRequest, res: NextApiResponse) => {
  const teamMember = await throwIfNoTeamAccess(req, res);

  throwIfNotAllowed(teamMember, 'team_dsync', 'delete');

  await throwIfNoAccessToDirectory({
    teamId: teamMember.team.id,
    directoryId: req.query.directoryId as string,
  });

  const data = await dsync.deleteConnection(req.query);

  sendAudit({
    action: 'dsync.connection.delete',
    crud: 'd',
    user: teamMember.user,
    team: teamMember.team,
  });

  res.status(200).json(data);
};
