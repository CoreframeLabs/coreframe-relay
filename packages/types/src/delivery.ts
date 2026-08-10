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
  isTest: z.boolean(),
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
 *
 * [RELAY-50] `isTest` flags the synthetic envelope produced by the dashboard's "Send
 * test webhook" button. It travels through the same ingest → queue → forward pipeline
 * as a real webhook — the point of the ticket — and its only divergence from real
 * traffic is that it is marked, excluded from billing counters, and badged TEST in
 * the log feed. It is defaulted to `false` here so a legacy producer that does not
 * yet send the field still round-trips — a required boolean would turn every old
 * payload into a poison message mid-deploy.
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
  /**
   * [RELAY-50] Marks a delivery as synthetic: produced by the "Send test webhook"
   * action rather than by an external sender. Default (not `.optional()`) so every
   * old message — and every forged request that omits the header — is treated as
   * REAL. Failing open here would silently let an unmarked webhook bypass the meter;
   * failing closed means a test webhook records itself as real, which is the
   * honest direction.
   */
  isTest: z.boolean().default(false),
});
export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;
