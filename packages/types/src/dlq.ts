import { z } from 'zod';
import { RequestIdSchema } from './delivery.js';

/** Payloads at or above this size are offloaded rather than stored inline. */
export const MAX_INLINE_PAYLOAD_BYTES = 64 * 1024;

export const DlqItemSchema = z
  .object({
    id: z.string().uuid(),
    routeId: z.string().uuid(),
    requestId: RequestIdSchema,
    failReason: z.string().min(1),
    attemptCount: z.number().int().min(0),
    /** Null when the body exceeded MAX_INLINE_PAYLOAD_BYTES — see `payloadKey`. */
    payload: z.unknown().nullable(),
    /** Object-storage reference used when `payload` is null. */
    payloadKey: z.string().nullable(),
    /** Retention by tier: Free now+7d, Pro now+30d, Business now+90d. */
    expiresAt: z.string().datetime(),
    retriedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .refine(
    (item) => item.payload !== null || item.payloadKey !== null,
    'a DLQ item must carry either an inline payload or a payloadKey — otherwise the body is unrecoverable and the item cannot be retried'
  );
export type DlqItem = z.infer<typeof DlqItemSchema>;
