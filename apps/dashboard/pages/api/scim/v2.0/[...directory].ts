import type { NextApiRequest, NextApiResponse } from 'next';
import type { DirectorySyncRequest } from '@boxyhq/saml-jackson';

import env from '@/lib/env';
import jackson from '@/lib/jackson';
import { extractAuthToken } from '@/lib/server-common';
import { handleEvents } from '@/lib/jackson/dsyncEvents';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // [security-audit 2026-09-16] `return` was missing: the 404 was sent and then
  // execution fell through to `directorySync.requests.handle(...)` anyway, so a
  // SCIM provisioning call (user create/delete, group membership) still ran
  // against the database with the feature switched off — the flag disabled the
  // response, not the operation. Every other dsync/sso handler in this codebase
  // `throw`s on its flag check; this one is a bare `res.status().json()` because
  // there is no surrounding try/catch, so an explicit `return` is the fix.
  if (!env.teamFeatures.dsync) {
    return res.status(404).json({ error: { message: 'Not Found' } });
  }

  const { directorySync } = await jackson();

  const { method, query, body } = req;

  const directory = query.directory as string[];
  const [directoryId, path, resourceId] = directory;

  // Handle the SCIM API requests
  const request: DirectorySyncRequest = {
    method: method as string,
    body: body ? JSON.parse(body) : undefined,
    directoryId,
    resourceId,
    resourceType: path === 'Users' ? 'users' : 'groups',
    apiSecret: extractAuthToken(req),
    query: {
      count: req.query.count ? parseInt(req.query.count as string) : undefined,
      startIndex: req.query.startIndex
        ? parseInt(req.query.startIndex as string)
        : undefined,
      filter: req.query.filter as string,
    },
  };

  const { status, data } = await directorySync.requests.handle(
    request,
    handleEvents
  );

  res.status(status).json(data);
}
