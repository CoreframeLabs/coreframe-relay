import { z } from 'zod';
import { RequestIdSchema } from './delivery';

/** Mirrors the `RiskLevel` and `ApprovalStatus` enums in prisma/schema.prisma. */
export const RiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ApprovalStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'TIMED_OUT',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/** e.g. { field: "amount", op: "gt", value: 100 } */
export const GateConditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']),
  value: z.unknown().optional(),
});
export type GateCondition = z.infer<typeof GateConditionSchema>;

export const GateRuleSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string().min(1).max(64),
  description: z.string().nullable(),
  condition: GateConditionSchema,
  riskLevel: RiskLevelSchema,
  timeoutMins: z.number().int().min(1).max(60 * 24 * 7),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GateRule = z.infer<typeof GateRuleSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  gateRuleId: z.string().uuid(),
  requestId: RequestIdSchema,
  payload: z.unknown(),
  status: ApprovalStatusSchema,
  riskLevel: RiskLevelSchema,
  approvedBy: z.string().nullable(),
  rejectedBy: z.string().nullable(),
  resolvedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  inngestRunId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
