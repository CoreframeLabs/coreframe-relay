# Using Relay in front of an n8n webhook

If you found this page from an n8n bug thread or the community forum: this is a setup
guide, not a sales pitch. It uses Relay's existing route-creation flow — nothing here is
unreleased or n8n-specific under the hood. Read the "What actually changes" section
before you touch anything; it says plainly which parts of your problem this fixes and
which parts it doesn't.

## The problem

n8n's own Webhook trigger node has a handful of documented, current reliability bugs. If
you're running Stripe, Shopify, WhatsApp, or any other webhook source through n8n, you've
probably hit one of these:

- **Webhooks randomly stop firing and need a manual workflow toggle to bring them back.**
  Reported on the n8n community forum under the title "Not Sustainable"
  ([community.n8n.io/t/…119667](https://community.n8n.io/t/help-needed-webhooks-randomly-stop-require-workflow-toggle-to-resume-not-sustainable/119667)).
  While the listener is silently down, anything sent during that window is gone — the
  sender doesn't know n8n stopped listening, and n8n never re-fires the events it missed.
- **Activating a workflow through the REST API doesn't always register the webhook
  path**, so a workflow deployed programmatically (CI/CD, infrastructure-as-code) can go
  live with a dead webhook until someone opens the n8n UI and re-saves it
  ([GitHub #21614](https://github.com/n8n-io/n8n/issues/21614) — a fix shipped in n8n
  2.14.0 via [PR #27161](https://github.com/n8n-io/n8n/pull/27161); if you're on an older
  version or a different edge case of the same bug class, it may still bite).
- **n8n Cloud enforces a hard 100-second Cloudflare timeout on webhook responses.** A
  workflow that takes longer than that to finish fails with a 524, regardless of what the
  workflow was actually doing
  ([n8n docs, common webhook issues](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/common-issues)).
- **A separate, still-open report of a Production Webhook that always returns 200 OK
  with nothing actually registered behind it**, on both n8n Cloud and fresh self-hosted
  workflows ([GitHub #16339](https://github.com/n8n-io/n8n/issues/16339)).

These bugs live inside n8n's own webhook-handling and activation logic. Relay doesn't
patch n8n's code and can't reach into n8n's internals — what it changes is what happens
to your data *while* n8n is having one of these moments, because Relay, not n8n, is the
first thing that receives the request.

## What actually changes, and what doesn't

Putting Relay in front of your n8n workflow means: instead of Stripe/Shopify/your other
webhook source posting directly to n8n's Production Webhook URL, it posts to a Relay
ingest URL. Relay durably queues the request, retries it with backoff against your n8n
webhook as the destination, and keeps a delivery log. Here's what that buys you against
each bug above, stated plainly — two of the four are things Relay can only make visible,
not fix:

| n8n's bug | Does Relay fix it? | What actually happens |
|---|---|---|
| Webhooks randomly stop firing, need a manual toggle | **Yes, the consequence.** | Relay receives the request first. While n8n's listener is down, the payload sits safely in Relay, gets retried with backoff, and lands in the DLQ (visible, manually replayable) if n8n never answers — instead of vanishing. |
| API-activation never registers the webhook path (#21614) | **No.** Relay can't register n8n's own listener. | Instead of a silently dead webhook, requests show up in Relay's delivery log as RETRYING → DLQ against a destination that keeps refusing. You get a real, timestamped failure signal instead of nothing. |
| n8n Cloud's 100-second Cloudflare timeout | **Yes, for the sender's side.** | Relay acknowledges the sender in milliseconds and forwards asynchronously. Stripe/Shopify never see n8n's processing time — they see Relay's ack. Relay's own forward to n8n waits up to 110 seconds before giving up — deliberately just past n8n's documented 100-second ceiling, so a workflow that legitimately takes n8n's full window still gets a real answer instead of being marked failed early. If n8n itself then times out (its own 524) or Relay's 110s forward window elapses first, that attempt becomes a RETRYING/DLQ item Relay keeps retrying, rather than the sender's own delivery attempt failing outright. See the duplicate-delivery note below before you rely on that retry against a slow workflow. |
| Production webhook always returns 200 OK with nothing registered (#16339) | **No — and this is the sharpest limit.** | If n8n accepts Relay's forwarded request and answers 200 while doing nothing, Relay's delivery log will honestly show DELIVERED, because that's what happened at the HTTP layer. Relay can prove "we handed this to n8n and n8n said OK." It cannot prove n8n's workflow actually ran. |

**Duplicate delivery against a slow workflow.** Relay's delivery guarantee is
at-least-once, not exactly-once — the same promise made on the landing page's "What
Founding Access doesn't include yet" section — and a slow n8n workflow is exactly where
that matters most. If your workflow takes close to n8n's own 100-second ceiling to finish,
and Relay's 110-second forward window elapses (or n8n answers slowly enough that the
retry backoff schedule fires again) before n8n's response comes back, Relay has no way to
know whether n8n actually finished your workflow — only that it didn't answer in time. The
next retry POSTs the same event to n8n again, and if the first invocation was still
running (or had run to completion but the response was lost), your workflow now runs
**twice** for one event. This is not hypothetical for a Stripe- or Shopify-backed
workflow: a duplicated event there is a duplicated refund, a duplicated fulfilment, or a
duplicated message.

Two things reduce this risk, and the second is the one that actually removes it:

- **Make the workflow idempotent**, keyed on the event id (Stripe's `id`, Shopify's
  `X-Shopify-Webhook-Id`, or Relay's own `relay-request-id` header, which rides every
  attempt — including retries — so every duplicate is identifiable even without a
  vendor id).
- **Set the Webhook trigger node's "Respond" option to "Immediately"** instead of "When
  Last Node Finishes", if your workflow doesn't need to return data computed during the
  run. This decouples the HTTP response Relay sees from how long your workflow actually
  takes to run: n8n answers Relay in milliseconds regardless of workflow length, Relay
  records DELIVERED immediately, and no retry has a reason to fire against a workflow
  that is still executing. Note this is a narrower fix than n8n's own documented
  workaround for the 524 timeout itself — their guide recommends splitting a genuinely
  long-running process into two webhooks (one to start the work and ack immediately, a
  second to poll for the result) rather than just changing the respond mode. "Respond
  Immediately" removes Relay's duplicate-delivery risk either way, but if your workflow
  can itself exceed n8n's 100-second ceiling, follow n8n's own two-webhook pattern for
  that part.

**Not covered at all:** WhatsApp/Meta's webhook verification handshake (`hub.mode`,
`hub.challenge`, `hub.verify_token`) is a separate, well-documented n8n pain point, but
Relay doesn't implement that handshake either. Don't route a WhatsApp Business API
verification step through Relay expecting it to work — it won't.

**One thing worth knowing before you rely on DLQ replay:** Relay's DLQ "Retry" button
resends the stored request body **with the original request headers**, signature headers
(`stripe-signature`, `x-hub-signature-256`, `x-shopify-hmac-sha256`) included, so an n8n
workflow that verifies a signature itself will see the same header the original delivery
carried. Two caveats remain, and both are about time rather than content:

- **Timestamped signatures can still go stale.** Stripe and others bind the signature to
  a timestamp and reject anything outside a tolerance window (Stripe's default is five
  minutes). A replay sent long after the original failure can therefore still be refused
  as stale, headers and all — that is the destination's clock, not something Relay
  withholds.
- **Items that predate this feature have no headers to replay.** DLQ rows written before
  header retention shipped never stored the map, so replaying one behaves the old way
  (body only). The confirm dialog tells you which of the two cases an item is in before
  you click.

## Before you start: one constraint that matters more for n8n than most

Relay validates every destination URL and rejects anything that resolves to a loopback
or private address (this is an anti-SSRF control, not an n8n-specific restriction). If
you're self-hosting n8n on a machine that isn't reachable from the public internet —
`localhost`, a private LAN address, a Docker-internal hostname with no public DNS — Relay
cannot reach it as a destination, for the same reason your original webhook sender
couldn't reach it either. You need a publicly resolvable URL for your n8n instance (n8n
Cloud gives you one automatically; a self-hosted instance needs a reverse proxy, tunnel,
or public DNS entry pointing at it) before Relay — or anything else on the internet — can
deliver to it.

## Setup, step by step

This uses Relay's existing sign-up and route-creation flow as it exists today. There is
no n8n-specific UI yet — you're using the same "New Route" wizard used for any
destination.

### 1. Get your n8n Production Webhook URL first

Open the workflow with the Webhook trigger node you want to protect. Make sure the
workflow is **activated** — n8n only serves the Production Webhook URL (as opposed to
the Test URL) once a workflow is active — and copy that Production URL from the node.
This is the URL n8n itself listens on to *receive* events; you're about to tell Relay to
forward to it, not the other way around.

### 2. Create a Relay account and a team

Sign up at Relay with email and password (there's no magic-link or OAuth sign-in yet, so
expect a normal password signup plus an email verification step). Once you're in, you'll
be asked to name a team — any name works; it's just a namespace your routes live under
and shows up as a path segment in your ingest URL later.

### 3. Create a route

From your team's Buffer → Routes page, click **New Route**. It's a 3-step wizard:

1. **Name** — name it after the thing that will be sending webhooks, e.g. "Stripe →
   n8n" or "Shopify orders." This also becomes part of your route's URL slug.
2. **Destination** — paste your n8n workflow's **Production Webhook URL** here (the one
   you copied in step 1). This is the field the wizard's copy currently just calls
   "Destination URL" — for this setup, destination always means your n8n instance, never
   Stripe/Shopify/etc. You can also set a max-retry count here (Relay defaults to 7); after
   that many failed attempts a payload moves to the DLQ instead of being dropped. If your
   n8n workflow expects a specific auth header on incoming requests, you can add it here
   too, but most n8n Webhook triggers don't require one by default.
3. **Get Relay URL** — Relay creates the route and shows you a URL that looks like:

   ```
   https://<relay-proxy-host>/in/<your-team-slug>/<your-route-slug>/<ingest-token>
   ```

   That whole URL, including the last path segment, is the credential — treat it like a
   secret. If it ever leaks, you can rotate it from the Routes table, which invalidates
   the old URL immediately.

### 3.5. Send a test webhook before you touch production traffic

Before you repoint anything real at this URL, find your new route in Buffer → Routes
and click **Send test**. It fires a synthetic webhook through this exact ingest URL —
not a mock — and polls the delivery log until the row appears, tagged **TEST** so it's
excluded from billing and never confused with real traffic. You can send it straight to
your n8n destination, or use the "send to the built-in catcher" option if you haven't
finished wiring your n8n workflow yet.

Watching that row go from QUEUED to DELIVERED (or DLQ, if the destination isn't reachable
yet) is the fastest way to confirm the pipeline actually works before you point a real
Stripe or Shopify webhook at a URL that has never carried a single request.

### 4. Repoint your webhook source at the Relay URL — not at n8n

This is the step that actually does the work, and it's the opposite direction of what
some people expect: **you are not changing anything about how n8n receives events.**
You're changing where the *original sender* (Stripe, Shopify, your CRM, whatever)
delivers to.

Go into your webhook source's own settings (Stripe's Developers → Webhooks, Shopify's
notification settings, etc.) and replace the n8n Production Webhook URL you had it
pointed at with the Relay ingest URL from step 3. Leave your n8n workflow's own webhook
node exactly as it is — Relay forwards to it, it doesn't replace it.

From this point on, the flow is: sender → Relay ingest URL → Relay queues and retries →
n8n's Production Webhook URL → your workflow.

## What you'll see once it's live

**The delivery log** (Buffer → Live Delivery Log, filterable down to just this route)
shows every request Relay has received and what happened to it, with a status badge per
row:

- **QUEUED** — received and durably stored, forwarding hasn't completed yet.
- **DELIVERED** — n8n answered with a success status. Remember: this means n8n accepted
  the HTTP request, not that your workflow necessarily finished successfully (see
  GitHub #16339 above).
- **RETRYING** — the forward to n8n failed and Relay is backing off before trying again.
- **FAILED / DLQ** — retries ran out. The payload is now sitting in the dead letter
  queue rather than lost.
- **TEST** — a row generated by Relay's own "Send test webhook" button, not real
  sender traffic. Colour-coded separately so it's never mistaken for a real delivery.

**The DLQ** (Buffer → Dead Letter Queue) lists everything that exhausted its retries. Each row
shows the route, the destination, and a Retry button that re-publishes the stored payload
back through the same delivery path — once per item, and only if the payload was
retained (payloads over 64KB aren't stored, so there's nothing to replay). As of RELAY-65
(merged 2026-08-19/20), a retry replays the original request headers too, so a signature
check your n8n workflow performs (Stripe-Signature, X-Hub-Signature-256,
X-Shopify-Hmac-SHA256) passes on replay the same way it did on the original delivery. The
one exception: a DLQ row created **before** RELAY-65 shipped has no headers stored against
it, so that specific row's replay is headerless — the confirm dialog states this per-row,
not as a standing limitation.

## What this setup does not give you (yet)

There's no dedicated n8n node, no in-canvas status view, and no listing in n8n's
community-node registry. You're using Relay's general-purpose route flow, pointed
manually at your n8n instance, the same way you'd point it at any other HTTP destination.
If a first-class n8n integration ships later, it will build on top of exactly this same
mechanism — it won't need you to redo anything you set up here.
