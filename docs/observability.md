# Observability — what £0 buys, what it misses, and when to pay

RELAY-44. Written against the code as it exists at `bb41645`, not against a plan.
Every mechanism named below was read in the source before being claimed here.

## 1. What "silent payload loss" means for Buffer

Buffer's failure mode is not downtime — it is the proxy answering `200 {"status":"queued"}`
while the queue consumer never runs. An uptime probe on `/health` proves the process is
alive and, for the dashboard, that Postgres answers one `SELECT 1`. It says nothing about
whether a payload accepted at the edge lands in `DeliveryLog`. The three ways a 200 lies:
the QStash token is rotated or wrong, so `publishToQStash` fails (the proxy answers 503,
a sender that does not retry loses the webhook); the route lookup fails over its KV cache
or the dashboard URL and the envelope is never constructed; or an SSRF false positive on a
customer's legitimate destination rejects with 502 and nobody reads the log line. In each
case every free uptime monitor reports green. For a product sold on *not losing webhooks*,
the unmonitored gap between "accepted" and "landed" is the whole risk.

## 2. What exists NOW, verified

| Mechanism | Covers | Does NOT cover | How a human reads it |
|---|---|---|---|
| **`GET /api/health`** (dashboard, `pages/api/health.ts`) | Process up **and** one real DB read — it runs `prisma.$queryRaw\`SELECT 1\`` before answering. Unauthenticated; returns only `{version}`, no team-scoped data. | Anything past "the database accepts a query": no queue, no consumer, no tenant data, no QStash. | `curl -s https://relay.coreframe-labs.dev/api/health` → `{"version":"…"}` and HTTP 200 is healthy; a 503 means Postgres is unreachable. |
| **Four structured Worker log events** (`apps/proxy/src/`) — `proxy.ingest.queued`, `proxy.unhandled_error`, `proxy.keepwarm.ping`, `proxy.keepwarm.no_target` | The proxy's own truth: every accepted publish logs `ingest.queued` with `requestId` + `messageId`; every crash logs `unhandled_error` with a stack; the daily RELAY-67 cron logs `keepwarm.ping` (with the dashboard's health status and version) or `keepwarm.no_target`. | Ratio analysis, history, alerting. Tail is a live stream — nothing is computed over it, and nobody is paged when `unhandled_error` appears. | `wrangler tail --format pretty \| grep -E "unhandled_error\|keepwarm"` in a shell; absence of `keepwarm.ping` at 04:17 UTC means the cron or the dashboard health endpoint is broken. **Requires the RELAY-42 deploy — until the real Worker is on `in.relay.coreframe-labs.dev`, these events exist only in `wrangler dev`.** |
| **`scripts/smoke-buffer.sh`** (RELAY-66, 10 steps) | The full path end to end: signup → session → route create → headerless webhook → a real `DeliveryLog` row (`isTest=false`) → test-flag split → DLQ write on final attempt → retry → direct DB counts. **Catches silent payload loss by construction** — a queue that accepts and drops fails step 5. | Scheduling. It runs when a human runs it. The script's `warn` call sites are expected skips/downgrades, not failures — seven categories appear on a passing local run: (1) no `psql` → step 10 skips its direct-SQL proof; (2) local SSRF wall → the real-sender leg's delivery runs through the `qstash-test` stand-in instead of a queued QStash message; (3) the test row is proven via the consumer with the `x-relay-event=test` contract, not the proxy-driven button; (4) DLQ retry answers 502 locally because QStash cannot reach a loopback callback; (5) the retried row is not `DELIVERED` within 15s for the same wall; (6) the `AuditLog` `dlq.retried` row is occasionally absent inside the poll window; (7) cold-compile `000` first-hit retries on the Next dev routes (`join`, `routes`, `qstash-test`, `test-send`) — transient and varying in count. | Run it, read the summary line: `SMOKE: PASS (N assertions, W warnings)`. PASS with warnings is a pass; FAIL exits at the failing step number. |
| **Dashboard Sentry** (`instrumentation.ts` + `sentry.client.config.ts`) | Unhandled exceptions on server (node/edge runtimes) and browser, sent to Sentry when `NEXT_PUBLIC_SENTRY_DSN` is set. Tracing is off (`tracesSampleRate` defaults `0.0`) — errors only, no spans. | No alert **rule** reaching a human is configured in code; nothing watches the Worker; a `NEXT_PUBLIC_SENTRY_DSN` that is unset silently disables it — the `init` runs with an `undefined` DSN and reports nothing. | Sentry project dashboard for the dashboard app. The events land; whether anyone is *notified* is an alert-policy setting in Sentry's UI, not in this repo. |

## 3. What is deliberately ABSENT

- **No Sentry on the Worker's edge.** RELAY-3's minimal-deps decision plus Wrangler
  3.99 and the absence of `@sentry/cloudflare` mean the proxy's only telemetry is
  `console.*` into Workers logs. Adding a Sentry SDK to the ingest path would put a
  wrapper around the endpoint customers' senders retry against — the wrong place to spend
  cold-start budget before there is traffic to justify it.
- **No metrics pipeline on the Worker.** `wrangler.toml` sets `[observability] enabled =
  true`, which is **logs-only**: it makes `wrangler tail` and the Cloudflare dashboard's
  log view work. It does not produce counters, histograms, or alerts.
- **No rolling-window DLQ/failure-ratio computation.** RELAY-44's third acceptance
  criterion — *a scheduled check queries `DlqItem` growth and `DeliveryLog` failure ratio
  over a rolling window and alerts* — is **not implemented, and stays unticked**. The
  deferred decision is recorded here rather than ticked: **the £0 next step is an
  `/api/relay/metrics` page the existing RELAY-67 cron (or a second cron entry) hits,
  which computes DLQ growth and failure ratio and answers non-2xx over a documented
  threshold; whether to build that page, or satisfy the criterion another way, is deferred
  — not decided.** Today the only reader of DLQ growth is a human running the smoke test
  or querying the DLQ page.

## 4. Upgrade thresholds — the three named triggers

1. **First paying customer** justifies Sentry at ≤ \$26/mo (Business tier is over budget
   until then; start at the cheapest paid plan that includes alert rules). The trigger is
   revenue, not traffic: an errors tool nobody is paged by is decoration.
2. **More than ~1,000 webhooks/week** outgrows `wrangler tail` as a debugging tool — at
   that volume `ingest.queued` scrolls past and grepping a live stream stops being
   search. Move to persisted log storage (Workers Logpush, or Sentry on the Worker) at
   this point, not before.
3. **One smoke PASS that should have FAILED** means the manual cadence itself is the
   failure mode: the check only runs when someone remembers, and someone didn't. Upgrade
   immediately — build the scheduled `/api/relay/metrics` check named in §3 or buy the
   equivalent, because the detection gap has been demonstrated in production, not
   hypothesised.

## 5. Monday-morning 5-min check

Three commands, one shell each. Healthy output shown.

```bash
cd coreframe-relay && SMOKE_PASSWORD=relay-dev@123 ./scripts/smoke-buffer.sh
```
Healthy: ends `SMOKE: PASS (… assertions, ≤7 warnings)`; every WARNING is one of the
seven known local-downgrade lines in §2.

```bash
cd coreframe-relay/apps/proxy && wrangler tail --format pretty | grep -E "unhandled_error|keepwarm"
```
Run while the smoke runs. Healthy: **silence** on `unhandled_error`, and (post RELAY-42
deploy, after 04:17 UTC) one `proxy.keepwarm.ping` with `"status":200`. Any
`unhandled_error` line is a bug to open today.

```bash
curl -s https://relay.coreframe-labs.dev/api/health
```
Healthy: HTTP 200 with `{"version":"…"}`. Anything else (000, 503, timeout) means the
dashboard cannot reach Postgres — the keep-warm cron has failed or the database is
paused.

## 6. What NOT to build

- **No OpenTelemetry.** A collector, an exporter and a backend are three new systems to
  operate at £0 for a two-process app; the smoke test already answers the question OTEL
  would be bought to answer.
- **No Grafana.** Dashboards over metrics that do not exist; §3's single metrics
  endpoint is the entire surface, and it renders as text.
- **No InfluxDB / timeseries DB.** A second datastore whose entire job would be holding
  numbers Postgres already holds; the failure ratio is one SQL query, not a timeseries.
- **No metrics timeseries table in Postgres.** Counting `DeliveryLog` and `DlqItem` over
  a window needs no new table — the rows are the data, and a roll-up table is a write
  path that can itself silently fail.
