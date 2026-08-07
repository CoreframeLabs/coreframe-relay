import { useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import { Plus } from 'lucide-react';
import type { RouteStatus } from '@prisma/client';
import fetcher from '@/lib/fetcher';
import { Button } from '@/components/ui/button';
import { RoutesTable, type RouteRow } from './RoutesTable';
import { NewRouteWizard } from './NewRouteWizard';

const FILTERS: Array<{ value: RouteStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'FAILING', label: 'Failing' },
];

/**
 * Buffer → Routes. [RELAY-6].
 *
 * Wrapped in `.dark` and the shadcn surface tokens: relay-ui-ux-spec.md §1.1 is
 * dark-mode-primary, while the surrounding BoxyHQ chrome is daisyUI. Scoping the theme to
 * this subtree is what [RELAY-1] deliberately left room for by NOT emitting shadcn's
 * global `body { @apply bg-background }` reset — so Relay pages can be dark without
 * restyling every inherited BoxyHQ page.
 */
export function BufferRoutes() {
  const router = useRouter();
  const { slug } = router.query as { slug?: string };
  const [filter, setFilter] = useState<RouteStatus | 'ALL'>('ALL');
  const [wizardOpen, setWizardOpen] = useState(false);

  const { data, error, isLoading, mutate } = useSWR<{ data: RouteRow[] }>(
    slug ? `/api/teams/${slug}/relay/routes` : null,
    fetcher
  );

  const routes = data?.data ?? [];
  const activeCount = routes.filter((r) => r.status === 'ACTIVE').length;

  return (
    <div className="dark min-h-full bg-background p-6 text-foreground">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Routes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isLoading
              ? 'Loading routes…'
              : `${activeCount} active ${activeCount === 1 ? 'route' : 'routes'} of ${routes.length}`}
          </p>
        </div>
        <Button size="sm" onClick={() => setWizardOpen(true)} disabled={!slug}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> New Route
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap gap-1" role="group" aria-label="Filter routes by status">
        {FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={filter === f.value ? 'secondary' : 'ghost'}
            onClick={() => setFilter(f.value)}
            aria-pressed={filter === f.value}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
          Could not load routes. {error instanceof Error ? error.message : ''}
        </div>
      ) : isLoading ? (
        <div className="rounded-lg border p-10 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : (
        <RoutesTable
          routes={routes}
          filter={filter}
          teamSlug={slug ?? ''}
          onRotated={() => mutate()}
        />
      )}

      {slug && (
        <NewRouteWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          teamSlug={slug}
          // Revalidate rather than splicing the new row in by hand: the server owns the
          // final slug (it de-duplicates), so the authoritative record is the one it
          // just wrote, not the one this component predicted.
          onCreated={() => mutate()}
        />
      )}
    </div>
  );
}
