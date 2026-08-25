import { Role } from '@prisma/client';
import { ApiError } from './errors';
import { getTeamMember } from 'models/team';

export async function validateMembershipOperation(
  memberId: string,
  teamMember,
  operationMeta?: {
    role?: Role;
  }
) {
  const updatingMember = await getTeamMember(memberId, teamMember.team.slug);

  // [RELAY-63] `getTeamMember` now returns `null` instead of throwing a raw Prisma
  // error when `memberId` (attacker-controllable: it comes straight off
  // `req.query`/`req.body` in members.ts's DELETE/PATCH handlers) is not actually a
  // member of this team. Previously this reached `updatingMember.role` on `null` --
  // a raw TypeError, the same "internal detail in the response" failure this ticket
  // is about, just via a different exception type. 404 matches the status this
  // caller's own team-access check already uses for "not visible to you".
  if (!updatingMember) {
    throw new ApiError(404, 'Member not found.');
  }

  // Member and Admin can't update the role of Owner
  if (
    (teamMember.role === Role.MEMBER || teamMember.role === Role.ADMIN) &&
    updatingMember.role === Role.OWNER
  ) {
    throw new ApiError(
      403,
      'You do not have permission to update the role of this member.'
    );
  }
  // Member can't update the role of Admin & Owner
  if (
    teamMember.role === Role.MEMBER &&
    (updatingMember.role === Role.ADMIN || updatingMember.role === Role.OWNER)
  ) {
    throw new ApiError(
      403,
      'You do not have permission to update the role of this member.'
    );
  }

  // Admin can't make anyone an Owner
  if (teamMember.role === Role.ADMIN && operationMeta?.role === Role.OWNER) {
    throw new ApiError(
      403,
      'You do not have permission to update the role of this member to Owner.'
    );
  }

  // Member can't make anyone an Admin or Owner
  if (
    teamMember.role === Role.MEMBER &&
    (operationMeta?.role === Role.ADMIN || operationMeta?.role === Role.OWNER)
  ) {
    throw new ApiError(
      403,
      'You do not have permission to update the role of this member to Admin.'
    );
  }
}
