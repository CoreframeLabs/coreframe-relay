import { Fragment, useMemo, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ExpandedState,
  type SortingState,
} from '@tanstack/react-table';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge } from './StatusBadge';
import { DlqPayloadPreview } from './DlqPayloadPreview';
import { DlqRetryButton } from './DlqRetryButton';
import type { DlqListRow } from 'models/dlq';

/**
 * The dead letter queue table. [RELAY-8]
 *
 * Same construction as [RELAY-6]'s `RoutesTable` — TanStack Table, shadcn `Table`
 * primitives, one row per record — with the accessibility precedents that ticket set and
 * [RELAY-10] corrected carried over verbatim:
 *
 *  - `aria-sort` lives on the `<th>`, NEVER on the sort `<button>`. `button` does not
 *    support the attribute, so putting it there announces nothing while looking correct
 *    in review. That was a real bug, found and fixed in [RELAY-10].
 *  - Every state is carried as TEXT as well as colour. A DLQ page is read during an
 *    incident, and "red row" is not information a red-green colourblind operator has.
 *  - Dates use an explicit `en-GB`/UTC formatter, per [RELAY-6]. Bare `toLocaleString()`
 *    renders per-machine, and 03/04 vs 04/03 in a screenshot costs an hour.
 */

/** A DLQ item as the API returns it. Structurally the model's `DlqListRow`. */
export type DlqRow = DlqListRow;

const columnHelper = createColumnHelper<DlqRow>();

const fmtDate = (value: string | null) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(d) + ' UTC';
};

/**
 * Compact form for the two timestamp columns: `04 Aug 03:59 UTC`.
 *
 * The year is dropped from the CELL only — never from the `title`, which always carries
 * the full `fmtDate` value. Measured at a 1500px viewport, the two full-length timestamp
 * columns were most of the 139px by which this table overran its container and forced a
 * horizontal scroll; a row is at most seven days old by retention, so the year cannot be
 * ambiguous in the cell. Still explicitly `en-GB` and still explicitly UTC — [RELAY-6]'s
 * rule is about removing per-machine ambiguity, and both survive here.
 */
const fmtDateCompact = (value: string | null) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      }).format(d) + ' UTC';
};

/**
 * How long until a row disappears, in plain words.
 *
 * Retention matters more on this page than anywhere else in the product: a DLQ item is
 * the ONLY remaining copy of a webhook that was never delivered. An operator needs to
 * know a row is about to vanish while they still have time to act on it, so the countdown
 * is stated in words rather than left implicit in a timestamp they would have to subtract
 * from today's date under pressure.
 *
 * Honest caveat, recorded by [RELAY-5] and unchanged: retention is currently the FREE
 * tier's 7 days for every team because nothing maps a team to a plan on this path, and no
 * reaper deletes expired rows — so `expiresAt` is a recorded intention. The page therefore
 * says "due for deletion", not "deleted".
 */
function expiryLabel(expiresAt: string): { text: string; urgent: boolean } {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return { text: '—', urgent: false };
  if (ms <= 0) return { text: 'Past retention', urgent: true };

  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return { text: `in ${hours}h`, urgent: true };

  const days = Math.floor(hours / 24);
  return { text: `in ${days}d`, urgent: days <= 1 };
}

/** Short form of a UUID for a dense column. The full value stays in `title`. */
const shortId = (id: string) => `${id.slice(0, 8)}…`;

/** Host + path, dropping the scheme. Same treatment [RELAY-6] gives the routes table. */
const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
};

export function DlqTable({
  rows,
  teamSlug,
  onRetried,
}: {
  rows: DlqRow[];
  teamSlug: string;
  onRetried: () => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'createdAt', desc: true },
  ]);
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'expand',
        header: () => <span className="sr-only">Expand payload</span>,
        cell: (info) => {
          const isOpen = info.row.getIsExpanded();
          return (
            <button
              type="button"
              onClick={info.row.getToggleExpandedHandler()}
              aria-expanded={isOpen}
              aria-controls={`dlq-payload-${info.row.original.id}`}
              className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {isOpen ? (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              )}
              <span className="sr-only">
                {isOpen ? 'Hide payload' : 'Show payload'}
              </span>
            </button>
          );
        },
      }),
      columnHelper.accessor((row) => row.route.name, {
        id: 'route',
        header: 'Route',
        cell: (info) => (
          // `max-w-*` rather than `min-w-0`, and that difference is not cosmetic. A table
          // lays out with `table-layout: auto`, so a column grows to fit its widest cell
          // and `truncate` never engages — which is how the destination URL pushed this
          // table past the viewport and scrolled the Route column out of sight. Measured
          // in a browser at 1500px, not reasoned about.
          <div className="max-w-[13rem]">
            <div className="truncate font-medium">{info.getValue()}</div>
            <div
              className="truncate font-mono text-xs text-muted-foreground"
              title={info.row.original.route.destination}
            >
              {hostOf(info.row.original.route.destination)}
            </div>
          </div>
        ),
      }),
      columnHelper.accessor('requestId', {
        header: 'Request',
        cell: (info) => (
          <span
            className="font-mono text-xs text-muted-foreground"
            title={info.getValue()}
          >
            {shortId(info.getValue())}
          </span>
        ),
      }),
      columnHelper.accessor('failReason', {
        header: 'Failure',
        cell: (info) => (
          <div className="flex min-w-0 flex-col gap-1">
            <StatusBadge state="DLQ" className="w-fit" />
            {/*
              The reason is a string WE composed in `lib/relay/forward.ts` — a status code
              or a timeout, never a response body from a customer's destination. It is
              still rendered as an escaped text child, like everything else here.
            */}
            <span
              className="max-w-[17rem] truncate text-xs text-muted-foreground"
              title={info.getValue()}
            >
              {info.getValue()}
            </span>
          </div>
        ),
      }),
      columnHelper.accessor('attemptCount', {
        header: 'Attempts',
        cell: (info) => (
          <span className="font-mono text-xs text-muted-foreground">
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor('createdAt', {
        header: 'Failed at',
        cell: (info) => (
          <span
            className="whitespace-nowrap font-mono text-xs text-muted-foreground"
            title={fmtDate(info.getValue())}
          >
            {fmtDateCompact(info.getValue())}
          </span>
        ),
      }),
      columnHelper.accessor('expiresAt', {
        header: 'Retention',
        cell: (info) => {
          const { text, urgent } = expiryLabel(info.getValue());
          return (
            <span
              className={
                urgent
                  ? 'whitespace-nowrap font-mono text-xs text-amber-300'
                  : 'whitespace-nowrap font-mono text-xs text-muted-foreground'
              }
              title={`Due for deletion ${fmtDate(info.getValue())}`}
            >
              {text}
            </span>
          );
        },
      }),
      columnHelper.accessor('retriedAt', {
        header: 'Retried',
        cell: (info) =>
          info.getValue() ? (
            <span
              className="whitespace-nowrap font-mono text-xs text-muted-foreground"
              title={fmtDate(info.getValue())}
            >
              {fmtDateCompact(info.getValue())}
            </span>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">—</span>
          ),
      }),
      columnHelper.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => (
          <DlqRetryButton
            row={info.row.original}
            teamSlug={teamSlug}
            onRetried={onRetried}
          />
        ),
      }),
    ],
    // Deliberately NOT `[expanded, …]`. Expansion now lives in TanStack's own row state,
    // read through `row.getIsExpanded()`, so toggling a payload open no longer rebuilds
    // the column definitions. See the remount note on `getRowId` below — this was half of
    // a real bug, not a micro-optimisation.
    [teamSlug, onRetried]
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getRowCanExpand: () => true,
    // ── The fix for a bug caught only by watching the page ─────────────────────────
    // TanStack defaults `row.id` to the row INDEX. After a retry, SWR revalidates and
    // hands back a fresh array; index 3 is then a different DLQ item wearing the same
    // React key, so every cell — including the open confirm dialog and its result
    // message — is torn down and rebuilt. Observed live: clicking "Re-send now"
    // published successfully and then the dialog simply vanished, leaving the operator
    // with no statement of what had happened to a payload that had just been re-sent.
    // Keying rows on the item's own id keeps identity stable across revalidation.
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm font-medium">Nothing in the dead letter queue</p>
        <p className="mt-1 text-sm text-muted-foreground">
          A webhook lands here only after every retry has been spent. An empty
          queue means everything Relay accepted was eventually delivered.
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
                  <TableHead
                    key={header.id}
                    // aria-sort on the columnheader, not the button. See the note at the
                    // top of this file — this exact placement was a bug once already.
                    aria-sort={
                      !sortable
                        ? undefined
                        : dir === 'asc'
                          ? 'ascending'
                          : dir === 'desc'
                            ? 'descending'
                            : 'none'
                    }
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                        <span aria-hidden="true" className="text-xs opacity-60">
                          {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}
                        </span>
                      </button>
                    ) : (
                      flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <Fragment key={row.id}>
              <TableRow
                // Every row here is a dead webhook, so the whole table carries the tint
                // [RELAY-6] reserved for failing rows. Colour is the secondary signal;
                // the DLQ badge in the Failure column is the primary one.
                className="bg-red-500/5 align-top"
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
              {row.getIsExpanded() && (
                <TableRow id={`dlq-payload-${row.original.id}`}>
                  <TableCell
                    colSpan={columns.length}
                    className="bg-background/60"
                  >
                    <DlqPayloadPreview
                      preview={row.original.payloadPreview}
                      payloadBytes={row.original.payloadBytes}
                      truncated={row.original.payloadTruncated}
                      failReason={row.original.failReason}
                    />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
