import type { DeliveryStatus } from '@prisma/client';

import { Button } from '@/components/ui/button';

/**
 * Route and status narrowing for the delivery feed. [RELAY-7]
 *
 * Both filters are applied SERVER-side, in the stream's Prisma query, not by filtering an
 * already-fetched array in the browser. With a hard 200-row window that difference is
 * visible rather than academic: filtering client-side would mean "last 200 deliveries, of
 * which these 3 are failures", while filtering server-side means "the last 200 failures" —
 * and the second is the one an engineer opened this page to see.
 */

export type StatusFilter = DeliveryStatus | 'ALL';

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'DELIVERED', label: 'Success' },
  { value: 'RETRYING', label: 'Retry' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'DLQ', label: 'DLQ' },
  { value: 'QUEUED', label: 'Queued' },
];

export type RouteOption = { id: string; name: string; slug: string };

export function DeliveryFilters({
  routes,
  routeId,
  onRouteChange,
  status,
  onStatusChange,
}: {
  routes: RouteOption[];
  routeId: string | 'ALL';
  onRouteChange: (value: string | 'ALL') => void;
  status: StatusFilter;
  onStatusChange: (value: StatusFilter) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <label
          htmlFor="delivery-route-filter"
          className="text-xs uppercase tracking-wide text-muted-foreground"
        >
          Route
        </label>
        {/*
          A native <select> rather than the shadcn Select primitive. `components/ui/*`
          carry hand edits for a react-i18next/Radix `children` conflict ([RELAY-19]) and
          the less of that surface this ticket depends on, the better; a native control
          also gets keyboard and screen-reader behaviour for free.
        */}
        <select
          id="delivery-route-filter"
          value={routeId}
          onChange={(event) => onRouteChange(event.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="ALL">All routes</option>
          {routes.map((route) => (
            <option key={route.id} value={route.id}>
              {route.name}
            </option>
          ))}
        </select>
      </div>

      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label="Filter deliveries by status"
      >
        {STATUS_FILTERS.map((filter) => (
          <Button
            key={filter.value}
            size="sm"
            variant={status === filter.value ? 'secondary' : 'ghost'}
            onClick={() => onStatusChange(filter.value)}
            aria-pressed={status === filter.value}
          >
            {filter.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
