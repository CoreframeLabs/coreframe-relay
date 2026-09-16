import type { NextApiRequest, NextApiResponse } from 'next';
import { getCookie } from 'cookies-next';
import { getSession } from '@/lib/session';
import { ApiError } from '@/lib/errors';
import { sessionTokenCookieName } from '@/lib/nextAuth';
import {
  findManySessions,
  findSessionIdByToken,
  PUBLIC_SESSION_SELECT,
} from 'models/session';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
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

// Fetch all sessions for the current user
const handleGET = async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await getSession(req, res);

  // [security-audit 2026-09-16] Defence in depth behind `middleware.ts`: with no
  // session, `where: { userId: undefined }` is no filter at all to Prisma, and
  // `findManySessions` would return every user's session rows (ids, user ids,
  // expiries — the token itself is excluded by RELAY-127's select).
  if (!session?.user?.id) {
    throw new ApiError(401, 'Unauthorized');
  }

  const sessionToken = await getCookie(sessionTokenCookieName, { req, res });

  // [RELAY-127] `sessionToken` is never selected here — it is a live bearer
  // credential under the database session strategy. `isCurrent` is derived by
  // comparing ids against a SEPARATE, single-row lookup keyed by the cookie
  // value, so the raw token only ever touches that one throwaway object and
  // never the array this handler responds with.
  const [sessions, currentSession] = await Promise.all([
    findManySessions({
      where: {
        userId: session.user.id,
      },
      select: PUBLIC_SESSION_SELECT,
    }),
    sessionToken ? findSessionIdByToken(sessionToken) : Promise.resolve(null),
  ]);

  sessions.map(
    (session) => (session['isCurrent'] = session.id === currentSession?.id)
  );

  // Sort sessions by most recent. `Array.prototype.sort` mutates in place and
  // returns the same reference, so no reassignment is needed (or possible —
  // `sessions` is a `const` from the destructure above).
  sessions.sort(
    (a, b) => Number(new Date(b.expires)) - Number(new Date(a.expires))
  );

  res.json({ data: sessions });
};
