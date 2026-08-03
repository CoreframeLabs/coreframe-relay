import { useMemo, useState } from 'react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge } from './StatusBadge';
import { CopyableUrl } from './CopyableUrl';
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
}: {
  routes: RouteRow[];
  filter: RouteStatus | 'ALL';
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);
  const [search, setSearch] = useState('');

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
        cell: (info) => <CopyableUrl url={info.getValue()} className="max-w-[18rem]" />,
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
    ],
    []
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
        <p className="text-sm font-medium">No routes yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          A route gives you a URL to hand to Stripe, Shopify or anything else that sends
          webhooks. Relay buffers what arrives and retries what fails.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const sortable = header.column.getCanSort();
                const dir = header.column.getIsSorted();
                return (
                  <TableHead key={header.id}>
                    {sortable ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        // Communicates sort state to screen readers, which the caret alone does not.
                        aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
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
                No routes match this filter.
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
