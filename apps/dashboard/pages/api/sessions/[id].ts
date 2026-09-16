import type { NextApiRequest, NextApiResponse } from 'next';
import { getSession } from '@/lib/session';
import { ApiError } from '@/lib/errors';
import { deleteSession, findFirstSessionOrThrown } from 'models/session';
import { validateWithSchema, deleteSessionSchema } from '@/lib/zod';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    switch (req.method) {
      case 'DELETE':
        await handleDELETE(req, res);
        break;
      default:
        res.setHeader('Allow', 'DELETE');
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

// Delete a session for the current user
const handleDELETE = async (req: NextApiRequest, res: NextApiResponse) => {
  const { id } = validateWithSchema(deleteSessionSchema, req.query);

  const session = await getSession(req, res);

  // [security-audit 2026-09-16] Defence in depth behind `middleware.ts`. The
  // ownership check below is `where: { id, userId: session?.user.id }`, and Prisma
  // drops an `undefined` field from the filter entirely — so with no session the
  // check degrades to "does a session with this id exist" and the delete that
  // follows would revoke ANY user's session by id. Refuse before the query.
  if (!session?.user?.id) {
    throw new ApiError(401, 'Unauthorized');
  }

  await findFirstSessionOrThrown({
    where: {
      id,
      userId: session.user.id,
    },
  });

  await deleteSession({
    where: {
      id,
    },
  });

  res.status(204).end();
};
