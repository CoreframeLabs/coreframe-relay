import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

export const deleteManySessions = async ({ where }) => {
  return await prisma.session.deleteMany({
    where,
  });
};

export const findFirstSessionOrThrown = async ({ where }) => {
  return await prisma.session.findFirstOrThrow({
    where,
  });
};

/**
 * [RELAY-127] Fields safe to hand back to a client listing their own browser
 * sessions. Excludes `sessionToken` — under NextAuth's database session
 * strategy that value IS a live bearer credential, equivalent in power to the
 * session cookie itself. `sessionStrategy` defaults to `jwt` today (so this
 * table is inert in practice), but the select must not depend on that staying
 * true.
 */
export const PUBLIC_SESSION_SELECT = {
  id: true,
  userId: true,
  expires: true,
} as const;

export const findManySessions = async ({
  where,
  select,
}: {
  where: Prisma.SessionWhereInput;
  select?: Prisma.SessionSelect;
}) => {
  return await prisma.session.findMany({
    where,
    ...(select ? { select } : {}),
  });
};

/**
 * [RELAY-127] Resolve the CURRENT session's id from the raw cookie value,
 * without ever selecting `sessionToken` back into an object a caller might
 * forward to a client. Used by `GET /api/sessions` to compute `isCurrent` by
 * id comparison instead of comparing raw tokens client-response-side.
 */
export const findSessionIdByToken = async (sessionToken: string) => {
  return await prisma.session.findUnique({
    where: { sessionToken },
    select: { id: true },
  });
};

export const deleteSession = async ({ where }) => {
  return await prisma.session.delete({
    where,
  });
};
