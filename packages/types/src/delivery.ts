import { z } from 'zod';

/** Mirrors the `DeliveryStatus` enum in prisma/schema.prisma. */
export const DeliveryStatusSchema = z.enum([
  'QUEUED',
  'DELIVERED',
  'RETRYING',
  'FAILED',
  'DLQ',
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/**
 * The correlation id carried end to end on the `relay-request-id` header: proxy → QStash
 * → consumer → DeliveryLog row. It is `@unique` in the database, which is what makes a
 * replayed QStash message idempotent rather than a double-write.
 */
export const RequestIdSchema = z.string().uuid();

export const DeliveryLogSchema = z.object({
  id: z.string().uuid(),
  routeId: z.string().uuid(),
  requestId: RequestIdSchema,
  sourceIp: z.string().nullable(),
  status: DeliveryStatusSchema,
  attemptCount: z.number().int().min(0),
  responseCode: z.number().int().min(100).max(599).nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  payloadSizeB: z.number().int().min(0).nullable(),
  createdAt: z.string().datetime(),
  deliveredAt: z.string().datetime().nullable(),
});
export type DeliveryLog = z.infer<typeof DeliveryLogSchema>;

/**
 * The envelope the proxy publishes to QStash and the consumer receives back.
 *
 * Headers are carried explicitly rather than replayed wholesale: hop-by-hop and auth
 * headers from the inbound request must never be forwarded to a customer destination.
 * [RELAY-4] owns the filtering; this type is the contract it filters into.
 */
export const RelayEnvelopeSchema = z.object({
  requestId: RequestIdSchema,
  routeId: z.string().uuid(),
  teamId: z.string().uuid(),
  destination: z.string().url(),
  maxRetries: z.number().int().min(1).max(10),
  receivedAt: z.string().datetime(),
  headers: z.record(z.string()),
  /** Raw body as received. Kept as a string so no re-encoding can alter a signature. */
  body: z.string(),
});
export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;
