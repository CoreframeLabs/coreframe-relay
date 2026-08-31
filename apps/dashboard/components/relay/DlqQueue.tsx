import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import fetcher from '@/lib/fetcher';
import { DlqTable, type DlqRow } from './DlqTable';
import { retryBlockedReason } from './DlqRetryButton';

/**
 * Buffer → Dead Letter Queue. [RELAY-8]
 *
 * Same shell as [RELAY-6]'s `BufferRoutes`: scoped `.dark` subtree over shadcn surface
 * tokens, SWR against a team-scoped API route, and no access control in the component —
 * that lives in the API route (`throwIfNoTeamAccess`), which is the boundary that
 * actually matters. A page-level check protects a render; the API check protects data.
 */

type DlqResponse = { data: { items: DlqRow[]; limit: number } };

export function DlqQueue() {
  const router = useRouter();
  const { slug } = router.query as { slug?: string };

  const { data, error, isLoading, mutate } = useSWR<DlqResponse>(
    slug ? `/api/teams/${slug}/relay/dlq` : null,
    fetcher
  );

  // Memoised, not `data?.data.items ?? []` inline: the `??` allocates a fresh array on
  // every render, which would make the `counts` memo below recompute every time and defeat
  // its own purpose. Caught by react-hooks/exhaustive-deps, not by reading.
  const rows = useMemo(() => data?.data.items ?? [], [data]);
  const limit = data?.data.limit ?? 0;

  // Stable across renders on purpose. An inline `() => mutate()` is a new function every
  // render, which invalidates `DlqTable`'s column memo, which remounts every cell — and
  // that is what made an open confirm dialog disappear the moment its own revalidation
  // landed. The other half of the fix is `getRowId` in `DlqTable`.
  const revalidate = useCallback(() => {
    mutate();
  }, [mutate]);

  const counts = useMemo(() => {
    return {
      total: rows.length,
      retryable: rows.filter((r) => retryBlockedReason(r) === null).length,
      unrecoverable: rows.filter((r) => !r.payloadRetained).length,
      retried: rows.filter((r) => r.retriedAt !== null).length,
    };
  }, [rows]);

  return (
    <div className="dark min-h-full bg-background p-6 text-foreground">
      <div className="mb-6">
        {slug && (
          <Link
            href={`/teams/${slug}/relay/buffer`}
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Routes
          </Link>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">
          Dead letter queue
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Webhooks that failed every delivery attempt. Retrying re-queues the
          stored payload for delivery to the route&apos;s destination again.
        </p>
      </div>

      {!isLoading && !error && rows.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            <span className="font-mono font-medium">{counts.total}</span>{' '}
            <span className="text-muted-foreground">
              {counts.total === 1 ? 'item' : 'items'}
            </span>
          </span>
          <span>
            <span className="font-mono font-medium">{counts.retryable}</span>{' '}
            <span className="text-muted-foreground">retryable</span>
          </span>
          {counts.retried > 0 && (
            <span>
              <span className="font-mono font-medium">{counts.retried}</span>{' '}
              <span className="text-muted-foreground">already retried</span>
            </span>
          )}
          {counts.unrecoverable > 0 && (
            // Surfaced as a headline number, not buried per-row. If a fifth of the queue
            // cannot be retried, that is the first thing an operator needs to know — and
            // it is the fact this page is most likely to hide.
            <span className="text-amber-300">
              <span className="font-mono font-medium">
                {counts.unrecoverable}
              </span>{' '}
              unrecoverable (no payload stored)
            </span>
          )}
          {counts.total >= limit && limit > 0 && (
            <span className="text-muted-foreground">
              showing the newest {limit} only
            </span>
          )}
        </div>
      )}

      {/*
        Retention is stated on the page, not just per row. It is currently the Free tier's
        7 days for EVERY team — nothing maps a team to a plan on this path yet — and no
        reaper deletes expired rows, so the wording is "due for deletion" rather than a
        promise about what has already happened. [RELAY-5] recorded both facts; repeating
        them here is cheaper than an operator discovering them during an incident.
      */}
      <p className="mb-4 text-xs text-muted-foreground">
        Items are retained for 7 days from failure. Retention is not yet
        tier-aware, and expired rows are not yet deleted automatically — the
        retention column shows when an item becomes due for deletion.
      </p>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400"
        >
          Could not load the dead letter queue.{' '}
          {error instanceof Error ? error.message : ''}
        </div>
      ) : isLoading ? (
        <div className="rounded-lg border p-10 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : (
        <DlqTable rows={rows} teamSlug={slug ?? ''} onRetried={revalidate} />
      )}
    </div>
  );
}
