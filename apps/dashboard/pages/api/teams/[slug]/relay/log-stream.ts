import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { DeliveryStatus } from '@prisma/client';

import { throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import {
  DELIVERY_FEED_MAX_ROWS,
  fetchTeamDeliveryFeed,
  type DeliveryFeedRow,
} from 'models/delivery';
import { validateWithSchema } from '@/lib/zod';
import { withTeamScope } from '@/lib/db/scope';

/**
 * GET /api/teams/:slug/relay/log-stream — Server-Sent Events feed of delivery attempts.
 * [RELAY-7]
 *
 * ── WHY THIS PATH, AND NOT `/api/relay/log-stream` AS THE TICKET WROTE IT ──────────────
 *
 * The acceptance criterion names `/api/relay/log-stream`. That path has nowhere safe to
 * get a team from. Its only options are a query parameter (`?teamId=`), which is the
 * IDOR the whole `models/route.ts` / `models/delivery.ts` `teamId` convention exists to
 * prevent, or a "the user's first team" heuristic, which is simply wrong for anyone in
 * two teams. Under `/api/teams/[slug]/` the slug in the path is not trusted either — it
 * is fed to `throwIfNoTeamAccess`, which resolves it against the SESSION's membership and
 * throws if the caller is not in that team. Every other team resource in this app works
 * this way, including `[RELAY-6]`'s routes endpoint, so authorization here behaves
 * identically to everything around it rather than being a bespoke second scheme.
 *
 * The team id used by every query below comes from `getCurrentUserWithTeam(...).team.id`
 * — session → membership → id. It is never read from the request.
 *
 * ── WHY THIS POLLS, AND IS NOT SUPABASE REALTIME ───────────────────────────────────────
 *
 * The criterion says "using Supabase Realtime + SSE". It was checked before being built
 * on, and Realtime cannot carry this feed today. Measured on the local stack, not assumed:
 *
 *  1. `supabase_realtime` publishes NO tables (`select * from pg_publication_tables` → 0
 *     rows), so `postgres_changes` emits nothing for `DeliveryLog`. A probe subscribed
 *     with both the anon and the service_role key, reached SUBSCRIBED on both, inserted a
 *     real `DeliveryLog` row, and received 0 events on both channels.
 *  2. Adding `DeliveryLog` to the publication temporarily did not change that — still 0
 *     events on both channels — so the gap is more than one `ALTER PUBLICATION`.
 *  3. RLS is enabled AND forced on `DeliveryLog` ([RELAY-11]) behind a policy keyed on
 *     `current_setting('app.current_team_id')`, a session GUC a Realtime subscriber
 *     cannot set. Measured: the `authenticated` role sees 0 of 22 rows. Realtime's
 *     row-level filtering also assumes Supabase Auth, and this app authenticates with
 *     NextAuth, so there is no JWT for it to evaluate a policy against.
 *  4. There is no `SUPABASE_URL`, anon key or service-role key anywhere in `.env` or
 *     `.env.example`. Inventing one is forbidden.
 *
 * So this endpoint polls the database on an interval and pushes diffs down the same SSE
 * interface. **The client is told this and shows it** — the snapshot event carries
 * `mode: 'poll'` and `intervalMs`, and the page's live indicator reads "Live · polled 2s",
 * not "Live". A feed that is secretly a poll is a lie about freshness that someone will
 * eventually debug an outage against. Swapping in Realtime later changes this file and
 * nothing else: the wire protocol below is the seam.
 *
 * ── [RELAY-84] WHY THE RLS SCOPE IS APPLIED TWICE ─────────────────────────────────────
 *
 * This is the one handler in the Relay path whose database work OUTLIVES the promise the
 * handler returns. `withTeamScope` opens an AsyncLocalStorage store, the setup below runs
 * inside it, and then the handler returns while a chained `setTimeout` keeps polling for
 * minutes. So there are two separate questions, and only the first is answered by copying
 * the pattern from `dlq/index.ts`:
 *
 *  1. Does the store cover the INITIAL fetch? Yes — it is awaited inside the callback.
 *  2. Does the store still cover the poll at t+2s, t+4s, … after `withTeamScope`'s promise
 *     has already resolved? MEASURED YES. AsyncLocalStorage binds the store to the async
 *     resource at creation time, so a `setTimeout` scheduled inside the store restores it
 *     when the callback fires, whether or not the enclosing `run()` has returned; the
 *     chain then continues because each `scheduleNextPoll` is itself called from inside a
 *     restored store. `__tests__/lib/rls-handlers.spec.ts` proves this with a detached
 *     chained timer whose ticks all fire AFTER the enclosing scope has resolved — the
 *     exact shape here, and a shape the RELAY-39 suite did not cover (its SSE test
 *     awaited each tick inside one still-open scope, which is a different, easier case).
 *
 * The poll query is nevertheless re-scoped explicitly in `tick`. That is deliberate
 * belt-and-braces on the single call site in this codebase where losing the scope is
 * INVISIBLE: `fetchTeamDeliveryFeed` under no scope returns `[]`, the diff finds nothing
 * added and nothing updated, no `delta` is sent, no `stream-error` is sent, and the page
 * shows a live-looking feed that will never move again. There is no error to trace and no
 * log line to grep. The re-scope is one nested `withTeamScope` on the same verified id —
 * innermost wins, same value, so it cannot widen anything — and it keeps the poll correct
 * even if a future refactor schedules it from outside the outer store.
 */

/** How often the database is polled. The UI states this number rather than implying 0. */
const POLL_INTERVAL_MS = 2000;

/**
 * Heartbeat period. An SSE connection with nothing to say looks idle to every proxy
 * between here and the browser, and idle connections get reaped — a comment line keeps
 * bytes moving without being an event the client has to understand.
 */
const HEARTBEAT_MS = 25_000;

const querySchema = z.object({
  slug: z.string(),
  routeId: z.string().uuid().optional(),
  status: z.nativeEnum(DeliveryStatus).optional(),
});

/**
 * `responseLimit: false` because this response never ends. Next warns (and in some
 * deployments truncates) once an API route exceeds 4 MB, which a long-lived stream will.
 */
export const config = {
  api: {
    responseLimit: false,
  },
};

/**
 * The fields whose change should be pushed as an update rather than ignored.
 *
 * A delivery row is not immutable: `recordDeliveryAttempt` UPDATEs it in place as QStash
 * retries, so `RETRYING → DELIVERED` never changes `createdAt`. A feed keyed only on "new
 * rows since timestamp X" would therefore show a retry starting and never show it
 * resolving, which is precisely the moment the page exists for.
 */
const fingerprint = (row: DeliveryFeedRow): string =>
  [
    row.status,
    row.attemptCount,
    row.responseCode ?? '',
    row.latencyMs ?? '',
    row.deliveredAt ? row.deliveredAt.toISOString() : '',
  ].join('|');

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Everything that can fail with a normal HTTP status must happen BEFORE the headers are
  // flushed. Once the stream is open there is no status code left to send.
  let streaming = false;

  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({
        error: { message: `Method ${req.method} Not Allowed` },
      });
      return;
    }

    const teamMember = await throwIfNoTeamAccess(req, res);

    // [perf] This used to also call `getCurrentUserWithTeam(req, res)` here, which
    // re-ran `getSession` and the exact same TeamMember⋈Team query `throwIfNoTeamAccess`
    // just ran, for the identical answer -- `getTeamMember`'s `include: { team: true }`
    // already put `.team` and `.role` on `teamMember`. That second query sat on this
    // handler's blocking path: nothing is written to the client (not even response
    // headers) until it resolves, because the SSE stream cannot open before the initial
    // snapshot is known. Measured on production (Playwright, real session, real network):
    // this endpoint's time-to-first-byte was ~370-410ms across 6 navigations from
    // Routes to Delivery Log, the slowest single request in that transition. Dropping the
    // duplicate removes one full DB round trip from that critical path with no change to
    // who is authorized -- `throwIfNoTeamAccess` already verified the same membership.
    //
    // [RELAY-84] `withTeamScope` is opened here rather than around the fetch alone, so
    // that BOTH the initial snapshot and the chained poll timer scheduled at the end of
    // this callback are created inside the store. See the header comment for why that is
    // sufficient for the timer chain and why `tick` re-scopes anyway.
    await withTeamScope(teamMember.teamId, async () => {
      throwIfNotAllowed(teamMember, 'team', 'read');

      const { routeId, status } = validateWithSchema(querySchema, req.query);

      // From the session's membership. Never from req.query, never from the body.
      const teamId = teamMember.team.id;
      const filter = { routeId, status };

      // The first page of rows is fetched before any header goes out, so a database that is
      // down answers 500 with JSON like every other endpoint instead of an empty stream that
      // looks like "no traffic yet".
      const initial = await fetchTeamDeliveryFeed(
        teamId,
        filter,
        DELIVERY_FEED_MAX_ROWS
      );

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        // `no-transform` matters as much as `no-cache`: a compressing intermediary will
        // happily buffer an event-stream into oblivion.
        'Cache-Control': 'private, no-cache, no-store, no-transform, max-age=0',
        Connection: 'keep-alive',
        // nginx-family proxies buffer proxied responses by default; this opts out.
        'X-Accel-Buffering': 'no',
      });
      streaming = true;

      // Without this Next's Pages Router holds the response until the handler returns, and
      // the stream appears to hang forever with nothing wrong in the logs.
      res.flushHeaders();

      // Node closes idle sockets on its own schedule; a stream that only speaks every 25s is
      // exactly the shape that trips it.
      res.socket?.setKeepAlive(true);
      res.socket?.setTimeout(0);

      let closed = false;
      let pollTimer: NodeJS.Timeout | undefined;

      const send = (event: string, data: unknown) => {
        if (closed || res.writableEnded) return;
        // JSON.stringify escapes newlines inside strings, so the payload is always one line
        // — which is what SSE's `data:` framing requires.
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const heartbeatTimer = setInterval(() => {
        if (closed || res.writableEnded) return;
        // A comment line: keeps bytes flowing past intermediaries without being an event the
        // client has to understand.
        res.write(`: heartbeat ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);

      /**
       * Decision 4 of the brief, and it is not theoretical: without this every navigation
       * away from the page leaves a timer holding a Prisma connection, and the dev server
       * falls over after a couple of dozen refreshes.
       */
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearTimeout(pollTimer);
        clearInterval(heartbeatTimer);
      };
      req.on('close', cleanup);
      req.on('aborted', cleanup);
      res.on('error', cleanup);

      // Seeded from the snapshot so the first poll does not re-announce every row it just
      // sent. Bounded at DELIVERY_FEED_MAX_ROWS entries because it is rebuilt from the
      // window each tick rather than accumulated.
      let known = new Map<string, string>(
        initial.map((row) => [row.id, fingerprint(row)])
      );

      send('snapshot', {
        rows: initial,
        maxRows: DELIVERY_FEED_MAX_ROWS,
        // Say what this actually is. See the header comment.
        mode: 'poll',
        intervalMs: POLL_INTERVAL_MS,
      });

      const scheduleNextPoll = () => {
        if (closed) return;
        // A chained timeout rather than setInterval: if a poll takes longer than the
        // interval, an interval stacks queries on a struggling database and makes it worse.
        pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      };

      const tick = async () => {
        if (closed || res.writableEnded) return;

        try {
          // [RELAY-84] Re-scoped explicitly. The ambient store from the handler's
          // `withTeamScope` does reach here (measured — see the header comment), so
          // this is redundancy, not a fix. It is kept because this is the one query
          // whose loss of scope produces NO error, NO empty-state, and NO log line:
          // just `[]`, an empty diff, and a feed that silently stops moving.
          const rows = await withTeamScope(teamMember.teamId, () =>
            fetchTeamDeliveryFeed(teamId, filter, DELIVERY_FEED_MAX_ROWS)
          );
          if (closed || res.writableEnded) return;

          const added: DeliveryFeedRow[] = [];
          const updated: DeliveryFeedRow[] = [];
          const next = new Map<string, string>();

          for (const row of rows) {
            const print = fingerprint(row);
            next.set(row.id, print);

            const previous = known.get(row.id);
            if (previous === undefined) {
              added.push(row);
            } else if (previous !== print) {
              updated.push(row);
            }
          }

          known = next;

          if (added.length > 0 || updated.length > 0) {
            // `added` keeps the query's newest-first order, which is what lets the client
            // prepend it without re-sorting.
            send('delta', { added, updated });
          }
        } catch (error) {
          // A failed poll is not a failed stream. Tell the client and keep the connection,
          // because dropping it turns a transient database blip into a page that has to be
          // reloaded by hand.
          send('stream-error', {
            message:
              error instanceof Error ? error.message : 'Delivery poll failed.',
          });
        }

        scheduleNextPoll();
      };

      // Scheduled INSIDE the store. That is what binds the whole poll chain to this
      // team's scope for the life of the connection — see the header comment.
      scheduleNextPoll();
    });
  } catch (error: any) {
    if (streaming) {
      // Headers are already out; a status code is no longer available. Close the stream
      // and let the client's reconnect logic take over.
      try {
        res.end();
      } catch {
        /* socket already gone */
      }
      return;
    }

    const message = error.message || 'Something went wrong';
    const status = error.status || 500;
    res.status(status).json({ error: { message } });
  }
}
