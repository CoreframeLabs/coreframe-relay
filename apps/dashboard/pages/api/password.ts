import { hashPassword, verifyPassword } from '@/lib/auth';
import { getSession } from '@/lib/session';
import type { NextApiRequest, NextApiResponse } from 'next';
// [security-audit 2026-09-16] This file imported `ApiError` from
// `next/dist/server/api-utils`, whose instances carry `.statusCode`, not the
// `.status` this handler's own `catch` reads (`error.status || 500`). Net effect:
// a wrong current password answered 500 "Your current password is incorrect"
// instead of 400. The codebase's own `ApiError` is what every other handler uses.
import { ApiError } from '@/lib/errors';
import { recordMetric } from '@/lib/metrics';
import { getCookie } from 'cookies-next';
import { sessionTokenCookieName } from '@/lib/nextAuth';
import env from '@/lib/env';
import { findFirstUserOrThrow, updateUser } from 'models/user';
import { deleteManySessions } from 'models/session';
import { validateWithSchema, updatePasswordSchema } from '@/lib/zod';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { method } = req;

  try {
    switch (method) {
      case 'PUT':
        await handlePUT(req, res);
        break;
      default:
        res.setHeader('Allow', 'PUT');
        res.status(405).json({
          error: { message: `Method ${method} Not Allowed` },
        });
    }
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;

    res.status(status).json({ error: { message } });
  }
}

const handlePUT = async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await getSession(req, res);

  // [security-audit 2026-09-16] Defence in depth. `middleware.ts` already redirects
  // a session-less request before it reaches here, but this handler's own next
  // line is `findFirstOrThrow({ where: { id: session?.user.id } })`, and Prisma
  // treats `{ id: undefined }` as NO filter — so if the middleware matcher ever
  // regressed (RELAY-129 was exactly such a matcher gap) this would resolve an
  // arbitrary User row and compare the caller's guess against ITS password hash.
  // A handler that reads `session?.user.id` must refuse when there is no session.
  if (!session?.user?.id) {
    throw new ApiError(401, 'Unauthorized');
  }

  const { currentPassword, newPassword } = validateWithSchema(
    updatePasswordSchema,
    req.body
  );

  const user = await findFirstUserOrThrow({
    where: { id: session.user.id },
  });

  if (!(await verifyPassword(currentPassword, user.password as string))) {
    throw new ApiError(400, 'Your current password is incorrect');
  }

  await updateUser({
    where: { id: session.user.id },
    data: { password: await hashPassword(newPassword) },
  });

  // Remove all sessions other than the current one
  if (env.nextAuth.sessionStrategy === 'database') {
    const sessionToken = await getCookie(sessionTokenCookieName, { req, res });

    await deleteManySessions({
      where: {
        userId: session.user.id,
        NOT: {
          sessionToken,
        },
      },
    });
  }

  recordMetric('user.password.updated');

  res.status(200).json({ data: {} });
};
