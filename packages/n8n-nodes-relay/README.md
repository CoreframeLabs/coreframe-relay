# n8n-nodes-relay

An [n8n](https://n8n.io) community node for [Coreframe Relay](https://coreframe-labs.dev)
— a webhook receipt, buffer, retry and dead-letter-queue service.

## What this node does

It sends a workflow item to a Relay route's ingest URL instead of a bare HTTP call, so the
request gets Relay's queue, retry-with-backoff and dead-letter-queue handling instead of
failing outright if the destination is briefly unreachable. Under the hood it's a plain
`POST` to Relay's already-public ingest endpoint
(`https://<relay-proxy-host>/in/<team-slug>/<route-slug>/<ingest-token>`) — nothing here
is a new Relay API, it's a thin, typed wrapper n8n users don't have to configure by hand.

## What this node does NOT do

- **It does not receive webhooks.** If you want Relay sitting in front of your n8n
  workflow's own Webhook trigger (the far more common case — protecting inbound events
  from Stripe, Shopify, etc.), you don't need this node at all: point the original sender
  at your Relay ingest URL, and set that route's destination to your workflow's normal
  n8n Production Webhook URL. Full walkthrough:
  [docs/integrations/n8n.md](https://github.com/CoreframeLabs/coreframe-relay/blob/main/docs/integrations/n8n.md).
  n8n's native Webhook trigger node is what receives Relay's forwarded request — nothing
  in this package replaces or wraps that.
- **It does not create, list, or configure Relay routes.** There is no public,
  token-authenticated API for that today — create the route in Relay's own dashboard
  first, then paste its ingest URL into this node's credential.
- **It does not show live delivery status (DELIVERED / RETRYING / DLQ) in the n8n
  canvas**, and can't offer a "wait for delivery confirmation" mode either — see
  "Why there's no delivery-status polling" below for exactly what's blocking that and
  why it's a backend gap, not something missing from this package's code.

If either of those becomes possible later (a route-management or delivery-status API
ships on Relay's side), this package is the natural place to add it — nothing here needs
to be redone.

## Install

> **Not published yet.** This package is not yet on the npm registry —
> `registry.npmjs.org/n8n-nodes-relay` currently 404s, and the Community Nodes install
> path below will fail until it is published. The instructions are correct for once
> publishing happens; there's nothing to install today. If you need Relay in front of an
> n8n webhook right now, use the general route flow instead — no node required:
> [docs/integrations/n8n.md](https://github.com/CoreframeLabs/coreframe-relay/blob/main/docs/integrations/n8n.md).

Community node install via the n8n UI: **Settings → Community Nodes → Install**, package
name `n8n-nodes-relay`. Self-hosted instances can also install it with:

```bash
npm install n8n-nodes-relay
```

## Set up the credential

1. In Relay: **Buffer → Routes → New Route**. Set the route's **Destination** to
   whatever this workflow should ultimately reach.
2. Copy the ingest URL shown on the last step of the wizard
   (`https://<relay-proxy-host>/in/<team-slug>/<route-slug>/<ingest-token>`) — treat it
   as a secret, it's the whole credential.
3. In n8n, create a **Relay Ingest URL** credential and paste it in. **Test** sends a
   real request tagged `x-relay-event: test`, so it proves the URL is live without
   counting as production traffic in Relay's own log.

## Use the node

Add a **Relay** node anywhere in a workflow, pick the credential, and choose whether to
send the current input item as-is or a custom JSON body. Optional extra headers are
forwarded to your destination (minus the small set of hop-by-hop and credential headers
Relay always strips). A **Mark as Test Request** toggle tags the send the same way the
credential test does.

Errors from Relay (rate limiting, an SSRF-rejected destination, a rotated/invalid ingest
token, an oversized payload) are mapped to a specific, actionable message and thrown as a
`NodeApiError` — n8n's class for a failed call to an external API, which is what shows the
message as the item's headline error in the canvas with the full explanation available in
"Show error details" and the HTTP status filterable in n8n's error UI. A malformed
credential (not an ingest-URL shape at all) is instead a `NodeOperationError`, thrown once
up front — that failure is a misconfigured node, not a rejected API call, which is the
line n8n's own error-handling reference draws between the two classes. See the node's
`describeRelayError` / `relayErrorTitle` if you're extending the mapping.

The credential's own **Test** button does the same thing one level up: it doesn't just
check for an HTTP success status, it asserts the response body actually has Relay
ingest's documented success shape (`{"status":"queued"}`), so a URL that happens to answer
200 without being a live Relay route still fails the test with an actionable message.

## Why there's no delivery-status polling

The one gap worth being precise about: this node cannot offer a "wait for delivery
confirmation" mode that polls Relay's delivery log (`GET
/api/teams/:slug/relay/log`) for a request's DELIVERED/RETRYING/DLQ status before
finishing. That endpoint exists and does exactly what you'd want — but it authenticates
with a NextAuth session cookie (`throwIfNoTeamAccess` → `getSession`), which an n8n
credential has no way to hold or refresh. Relay does have a separate team-API-key
mechanism (`apps/dashboard/models/apiKey.ts`), but as of this writing nothing in the
dashboard actually authenticates a request with it — `getApiKey()`'s only caller is the
key's own delete-guard, not any data-reading endpoint — so it isn't a usable path today
either. This is a Relay backend gap, not an n8n limitation: the ingest endpoint this node
already calls is happy to authenticate a non-browser caller on a per-route token; the
delivery-log endpoint is not. Closing it is a backend decision (whether to extend the
existing ingest-token trust boundary to a read, or wire up the unused API-key mechanism)
big enough to want its own review rather than being decided inside this package.

## Status

Built and unit-tested (`pnpm test`, 23 tests) against `n8n-workflow`'s published types,
**and verified against a real, running n8n 2.37.7 instance in Docker** — loaded as a
custom extension, executed in a real workflow (Manual Trigger → Relay) against Coreframe
Relay's live production ingest endpoint, confirmed end-to-end via the resulting
`DeliveryLog` row, and exercised on both the success path and the `NodeApiError` failure
path (a real 404 from an invalid route). That live run is also what caught and fixed a
real bug: n8n's `httpRequest` helper's underlying client is axios, whose errors carry the
HTTP status at `error.response.status`, not `.statusCode` — the shape this node's error
mapping originally checked for and a case no mocked-context unit test would have exposed.
If you hit something that doesn't match this README, please open an issue on
[coreframe-relay](https://github.com/CoreframeLabs/coreframe-relay/issues) — this is a
new package.

## License

MIT
