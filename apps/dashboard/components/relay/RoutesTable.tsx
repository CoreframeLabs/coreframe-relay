import { useMemo, useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import type { Route, RouteStatus } from '@prisma/client';
import { Check, Copy, Eye, EyeOff, Loader2, RotateCw } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { StatusBadge } from './StatusBadge';
import { CopyableUrl } from './CopyableUrl';
import { SendTestButton } from './SendTestButton';
import { cn } from '@/lib/utils';

/** A Route as the API returns it — the model plus its derived public URL. */
export type RouteRow = Route & { relayUrl: string };

const columnHelper = createColumnHelper<RouteRow>();

/**
 * Routes table — relay-ui-ux-spec.md §3.2.
 *
 * Dates are formatted with an explicit `en-GB` locale and UTC. `toLocaleString()` with no
 * locale renders differently per machine, which turns a screenshot in a bug report into
 * an ambiguous timestamp — and 03/04 vs 04/03 is exactly the kind of ambiguity that costs
 * an hour during an incident.
 */
const fmtDate = (value: Date | string | null) => {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(d) + ' UTC';
};

/** Strip the scheme so the destination column reads as a host, not a wall of https://. */
const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
};

export function RoutesTable({
  routes,
  filter,
  teamSlug,
  onRotated,
}: {
  routes: RouteRow[];
  filter: RouteStatus | 'ALL';
  /** Tenant scope for the rotate call — from the page's own router, never a row. */
  teamSlug: string;
  /** [RELAY-57] invoked after a rotation so the SWR cache refetches with the new URL. */
  onRotated: () => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);
  const { t } = useTranslation('common');
  const [search, setSearch] = useState('');

  // ── [RELAY-57] reveal / copy / rotate, per row. ────────────────────────────────────
  // The token lives in every string here and nowhere else: `relayUrl` is the only place
  // it appears in the payload, so mask/reveal operate on that one string and a rotated
  // row is a fresh row. `revealedIds` and `copiedId` reset by keyed state, not by
  // effect — a user who reveals a row and then rotates it must not see the OLD token
  // flash back while the new one loads.
  const [revealedIds, setRevealedIds] = useState<ReadonlySet<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const toggleReveal = (id: string) =>
    setRevealedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Redact exactly the last path segment — the token — leaving the slugs legible. */
  const maskUrl = (url: string) => url.replace(/\/[^/]+$/, '/••••••••');

  const copyUrl = async (route: RouteRow) => {
    try {
      await navigator.clipboard.writeText(route.relayUrl);
      setCopiedId(route.id);
      setTimeout(() => setCopiedId((c) => (c === route.id ? null : c)), 1600);
    } catch {
      // The instruction is in the row itself once revealed; a toast here would be a
      // second place to say the same thing and a first place to look when copy fails.
    }
  };

  const rotate = async (route: RouteRow) => {
    setRotatingId(route.id);
    setRotateError(null);
    try {
      // Revocation is server-side and immediate; the payload shape is relayUrl-bearing.
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamSlug)}/relay/routes/${route.id}/rotate-token`,
        { method: 'POST' }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || 'Rotate failed.');
      // Clear this row's reveal so a stale token never stays visible after rotation.
      setRevealedIds((current) => {
        const next = new Set(current);
        next.delete(route.id);
        return next;
      });
      onRotated();
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : 'Rotate failed.');
    } finally {
      setRotatingId(null);
    }
  };

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: 'Name',
        cell: (info) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{info.getValue()}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              /{info.row.original.slug}
            </div>
          </div>
        ),
      }),
      columnHelper.accessor('relayUrl', {
        header: 'Relay URL',
        enableSorting: false,
        cell: (info) => {
          const route = info.row.original;
          const url = info.getValue();
          const revealed = revealedIds.has(route.id);
          const rotating = rotatingId === route.id;
          const copied = copiedId === route.id;

          return (
            <div className="flex min-w-0 max-w-[22rem] items-center gap-1.5">
              {/* Revealed: full URL, copyable. Masked: token redacted, not copyable. */}
              {revealed ? (
                <CopyableUrl url={url} className="min-w-0 flex-1" />
              ) : (
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
                  title="Reveal the ingest URL to copy it"
                >
                  {maskUrl(url)}
                </span>
              )}

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => toggleReveal(route.id)}
                aria-pressed={revealed}
                aria-label={revealed ? 'Hide ingest URL' : 'Reveal ingest URL'}
                disabled={rotating}
              >
                {revealed ? (
                  <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => copyUrl(route)}
                aria-label={copied ? 'Copied' : 'Copy ingest URL'}
                disabled={rotating}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </Button>

              {/* Rotate: new token now, old one dead now, confirmed by refetch. */}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => rotate(route)}
                aria-label="Rotate ingest token"
                disabled={rotating}
                title="Rotate token — the old URL stops working immediately"
              >
                {rotating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </Button>
            </div>
          );
        },
      }),
      columnHelper.accessor('destination', {
        header: 'Destination',
        cell: (info) => (
          <span
            className="block max-w-[16rem] truncate font-mono text-xs text-muted-foreground"
            title={info.getValue()}
          >
            {hostOf(info.getValue())}
          </span>
        ),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: (info) => <StatusBadge state={info.getValue()} />,
      }),
      columnHelper.accessor('maxRetries', {
        header: 'Retries',
        cell: (info) => (
          <span className="font-mono text-xs text-muted-foreground">{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor('createdAt', {
        header: 'Created',
        cell: (info) => (
          <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
            {fmtDate(info.getValue())}
          </span>
        ),
      }),
      // [RELAY-50] One action column, one button. The button's own popover carries
      // "Send to the built-in catcher" as a second step for an onboarding user who
      // has not wired a destination yet; the column header is the action, not the
      // route, so it is not sorted or filtered.
      columnHelper.display({
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: (info) => {
          const route = info.row.original;
          // A PAUSED route is the one an operator is debugging — the button must
          // remain visible there. ARCHIVED rows do not reach this table today, so
          // the guard is written as an allow-list so a new status fails closed.
          if (route.status !== 'ACTIVE' && route.status !== 'FAILING') {
            return null;
          }
          return (
            <div className="relative flex justify-end">
              <SendTestButton
                routeId={route.id}
                teamSlug={teamSlug}
                routeName={route.name}
              />
            </div>
          );
        },
      }),
    ],
    // Rebuilt whenever per-row interaction state changes: cell renderers read
    // `revealedIds`/`rotatingId`/`copiedId` from closure, and a memo that ignored them
    // would leave a revealed token visible — or a spinner frozen — after the state moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revealedIds, rotatingId, copiedId, teamSlug, onRotated]
  );

  const data = useMemo(
    () => (filter === 'ALL' ? routes : routes.filter((r) => r.status === filter)),
    [routes, filter]
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter: search },
    onSortingChange: setSorting,
    onGlobalFilterChange: setSearch,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  if (routes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm font-medium">{t('no-routes-title')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('no-routes-description')}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      {rotateError && (
        // [RELAY-105] Was unconditionally 'border-red-500/30 bg-red-500/5 text-red-400'
        // — text-red-400 on this banner's own bg-red-500/5-over-white composite measures
        // 2.60:1 in light mode (computed; fails 4.5:1 AA). Light pairing now matches the
        // spec's error tint (bg-red-50/text-red-700); dark keeps the original values via
        // the same `dark:` gating used throughout this codebase.
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/5 dark:text-red-400">
          {rotateError}
        </p>
      )}
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const sortable = header.column.getCanSort();
                const dir = header.column.getIsSorted();
                return (
                  <TableHead
                    key={header.id}
                    // aria-sort belongs on the columnheader, NOT on the button inside it —
                    // `button` does not support the attribute, so putting it there
                    // communicates nothing to a screen reader while looking correct.
                    aria-sort={
                      !sortable ? undefined
                        : dir === 'asc' ? 'ascending'
                        : dir === 'desc' ? 'descending'
                        : 'none'
                    }
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <span aria-hidden="true" className="text-xs opacity-60">
                          {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}
                        </span>
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                {t('no-routes-match-filter')}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                // §3.2: failing rows carry a subtle red tint across the whole row.
                className={cn(row.original.status === 'FAILING' && 'bg-red-500/5')}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
