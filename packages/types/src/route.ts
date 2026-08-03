import { z } from 'zod';

/**
 * A Route is one inbound webhook endpoint.
 *
 * DEVIATION from relay-engineering-standards.md Part 4, which models routes against
 * `userId`. BoxyHQ — and therefore the Prisma schema landed in [RELAY-2] — is
 * team-scoped, and the sprint plan's own endpoint is `POST /in/:teamSlug/:routeSlug`.
 * Ownership is by team. Keeping `userId` here would have put the shared contract at odds
 * with the database on day one.
 */

/** Mirrors the `RouteStatus` enum in prisma/schema.prisma. */
export const RouteStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'FAILING']);
export type RouteStatus = z.infer<typeof RouteStatusSchema>;

/**
 * URL-safe, lowercase, no leading/trailing or doubled hyphens. This value goes straight
 * into a public path segment, so the shape is validated rather than trusted.
 */
export const RouteSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens only');

/**
 * Destination must be an absolute http(s) URL.
 *
 * This is a SHAPE check only and is deliberately not the SSRF defence — that lives in the
 * proxy ([RELAY-4]) because it has to resolve DNS at request time. A URL that looks fine
 * here can still point at link-local or private space, and can change what it resolves to
 * between validation and delivery.
 */
export const DestinationUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'destination must be an http(s) URL');

export const RouteSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string().min(1).max(64),
  slug: RouteSlugSchema,
  destination: DestinationUrlSchema,
  /** Bounded because it maps onto QStash's retry budget, not an arbitrary counter. */
  maxRetries: z.number().int().min(1).max(10).default(7),
  status: RouteStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Route = z.infer<typeof RouteSchema>;

/** What a user supplies when creating a route — the server owns everything else. */
export const CreateRouteSchema = RouteSchema.pick({
  name: true,
  destination: true,
  maxRetries: true,
});
export type CreateRouteInput = z.infer<typeof CreateRouteSchema>;

export const UpdateRouteSchema = CreateRouteSchema.partial().extend({
  status: RouteStatusSchema.optional(),
});
export type UpdateRouteInput = z.infer<typeof UpdateRouteSchema>;
