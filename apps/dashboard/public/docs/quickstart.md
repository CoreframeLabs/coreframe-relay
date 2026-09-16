# Put Relay in front of any webhook endpoint

> Source: https://relay.coreframe-labs.dev/docs/quickstart
> This file is a hand-transcribed Markdown mirror of that page (no shared
> Markdown source exists for this page — see `pages/docs/quickstart.tsx`'s own
> header comment). If the page changes, this file needs a matching edit.

This is the general path: one route in front of one endpoint, with any sender.
It uses the same New Route wizard for every destination — there is nothing
sender-specific to configure, and nothing here is unreleased. Four steps, then
what you'll see in the delivery log and what the limits are.

Using n8n? Read the [n8n guide](/docs/integrations/n8n.md) instead.

## Before you start

You need two things, and both are yours, not Relay's:

- **An endpoint Relay can reach from the public internet.** Relay validates
  every destination URL and rejects anything that resolves to a loopback or
  private address — `localhost`, a LAN address, a Docker-internal hostname
  with no public DNS. This is an anti-SSRF control, not a plan limit. A
  tunnel, reverse proxy, or public DNS entry in front of a private service is
  fine; a bare private address is not.
- **A webhook sender whose destination URL you control.** Stripe, Shopify,
  GitHub, Meta, a cron job you wrote — anything that POSTs to a URL you can
  change in its settings. Relay doesn't need a custom header from the sender;
  the URL itself is the credential (see step 2).

If the thing sending or receiving your webhooks is n8n, read the
[n8n guide](/docs/integrations/n8n.md) instead — same mechanism, but it covers
n8n's own webhook bugs and what Relay can and can't do about each of them.

## Step 1 — Create an account and a team

[Request Founding Access](/auth/join) is one form: your name, a team name,
your email, and a password. There's no magic link or OAuth sign-in yet. After
you submit, you're sent to a verify-your-email screen; click the link in that
email and sign in. Founding Access is free — no card, nothing charged — and
the team you named is where your routes live.

## Step 2 — Create a route

Once signed in, the left-hand navigation for your team has three Relay
entries: **Routes**, **Delivery Log** and **DLQ**. Open **Routes** and click
**New Route**. The wizard is three steps:

1. **Name.** Name the route after the service that will send to it ("Stripe
   events", say). The name becomes the last human-readable segment of your
   ingest URL — the wizard shows the slug as you type.
2. **Destination.** Paste the http(s) URL Relay should forward to — your
   existing endpoint, exactly as it is today. Two optional fields on the same
   step:
   - **Max retries** — defaults to 7, accepts 1 to 10. After this many failed
     attempts the payload moves to the dead letter queue rather than being
     dropped.
   - **Destination auth headers** — if your endpoint requires a header to
     accept a request (an `authorization` bearer, an `x-api-key`), add it here
     and Relay sends it on every forward. Only a short allowlist of header
     names is accepted (`authorization`, `x-api-key`, `x-auth-token`,
     `x-access-token`, `x-signature`, `x-hmac-signature`, `x-webhook-secret`,
     `x-github-hook-secret`); values are encrypted at rest and never shown
     again after you save.
3. **Your Relay URL.** Clicking **Create route** shows the ingest URL. It
   looks like this:

   ```
   https://<relay-proxy-host>/in/<your-team>/<route-slug>/<ingest-token>
   ```

**Treat the whole URL as a secret.** The last path segment is the route's
ingest token; there is no separate signing header a sender has to set, which
is why Stripe, Shopify, GitHub and Meta can all post to it unchanged. If it
ever leaks, use the **Rotate ingest token** control on that row of the Routes
table — the old URL stops working immediately and you get a new one to paste
into your sender.

## Step 3 — Confirm the pipeline before a real sender touches it

The last wizard screen has a **Send test** button. It fires one synthetic
webhook through the route's real ingest URL and waits for the delivery-log row
that the pipeline writes — it is end-to-end proof the request went in and came
out, not a mock. The result (status, response code, latency) appears on the
button itself.

If you haven't got a destination ready yet, the same menu offers **Send to the
built-in catcher**. That re-points the route at a receiver Relay hosts, then
sends — so you can watch a delivery succeed before you have anything of your
own to deliver to. It changes the route's destination, so set it back to your
real endpoint (the **Edit destination** control on the Routes row) before
step 4.

Test rows are marked **TEST** in the log so they can't be mistaken for sender
traffic.

## Step 4 — Point your sender at the Relay URL

Go into your sender's own settings (Stripe's Developers → Webhooks, Shopify's
notification settings, a GitHub repository's Webhooks page, your own
scheduler's config) and replace the URL it currently posts to with the Relay
ingest URL from step 2. Leave your endpoint exactly as it is — Relay forwards
to it, it doesn't replace it.

From this point on, every request takes this path:

```
sender
  → Relay ingest URL          (answers 200 the moment the request is durably queued)
  → Relay forwards to your destination, retries with backoff on failure
  → your endpoint
```

Relay answers the sender with `200`, not `202`, on purpose: a meaningful
number of webhook senders in the wild test for exactly 200 and treat anything
else as a failed delivery. That 200 means "stored, will be forwarded" — it is
not your endpoint's response.

## What you'll see once it's live

**Delivery Log** shows every request Relay has received, filterable to one
route, with one of these statuses:

- **QUEUED** — received and durably stored; forwarding hasn't completed yet.
- **DELIVERED** — your destination answered with a success status. This is
  the HTTP layer's word for it: your endpoint accepted the request. It says
  nothing about what your handler did with it afterwards.
- **RETRYING** — the forward failed and Relay is backing off before trying
  again.
- **FAILED / DLQ** — retries ran out. The payload now sits in the dead letter
  queue rather than being lost.
- **TEST** — a row from the Send test button, not sender traffic.

**DLQ** lists everything that exhausted its retries. Each row shows the
route, the destination, and a **Retry** button that re-publishes the stored
payload through the same delivery path — with the original request headers,
so a vendor signature (`stripe-signature`, `x-hub-signature-256`,
`x-shopify-hmac-sha256`) is replayed as it arrived. Retry is allowed once per
item, so a double-click cannot double-deliver. Two exceptions the confirm
dialog states per row: a payload over 64KB has no stored body to replay (see
below), and a DLQ row written before header retention shipped replays
body-only.

## Limits worth knowing before you rely on this

These are the same limits the landing page's "What Founding Access doesn't
include yet" list and the [Terms](/terms) state — repeated here so you don't
have to go looking:

- **Payloads over 1 MiB are refused with a 413** before they are buffered —
  counted as they stream, never silently truncated. The sender gets the 413;
  nothing is queued.
- **Payloads between 64KB and 1 MiB are delivered and retried like any
  other, but are not replayable from the DLQ.** The DLQ only retains a body
  for manual replay up to 64KB. A bigger payload that ends up there is still
  logged — requestId, status, timestamps, headers — with nothing hidden; it
  just has no body to re-send, and the Retry button on that row is disabled
  and says why.
- **A paused route answers 404 and can't be retried into.** Pausing (in the
  Edit destination dialog) means "stop sending to this destination": new
  webhooks to that ingest URL get a 404 until it is resumed, and DLQ Retry
  refuses until then too.
- **Relay can't reach a private address** (see "Before you start"), and it
  can't make your handler correct — a 4xx from your endpoint is logged and
  lands in the DLQ like any other failure.

There is no SLA, status page or service credit today — the
[Terms](/terms) say so in §3. If something here doesn't match what you see in
the product, that is a bug in this page — email info@coreframe-labs.dev.
