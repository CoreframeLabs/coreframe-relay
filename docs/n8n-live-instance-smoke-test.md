# n8n live-instance smoke test — RELAY-109

## Why this document exists

`packages/n8n-nodes-relay` is built and unit-tested (14/14 passing, `pnpm test` from that
directory) but has never been loaded by an actual running n8n process. The tests prove it
themselves — the mock context in `packages/n8n-nodes-relay/test/relay.node.test.ts:8-12`
says outright: "this exercises the node's own request-building and error-mapping logic
exactly as n8n would call it, but it is not n8n itself — nothing here proves the node
loads correctly inside a running n8n instance." The package's own README repeats this at
`packages/n8n-nodes-relay/README.md:70-71`: "Built and unit-tested... **not yet run
against a live n8n instance**."

Two prior attempts to close this stalled because `docker pull n8nio/n8n:latest` timed out
in that sandbox — no Docker registry egress. This runbook assumes whoever runs it (a
human, on a machine with normal internet access) does **not** have that restriction. It
is written so no judgment calls are needed: every command is concrete, every URL and
env var is named, and the evidence to collect is specified exactly. Budget 10 minutes.

If you hit a step that doesn't work as written, that's useful signal — see "Failure modes"
at the bottom before assuming you did something wrong.

## What you need before starting

- Docker, with working registry egress (`docker pull hello-world` should succeed).
- Node.js >= 20 and pnpm 9.12.3 (`packageManager` field in the repo root
  `package.json:5`) on the host, to build the package.
- A real Relay account with at least one team, and dashboard access to create a route
  (Buffer → Routes → New Route, per `docs/integrations/n8n.md`, "Setup, step by step").
  Use a test/throwaway route — this will generate real rows in that team's delivery log,
  tagged as TEST if you follow step 5 below.

## Step 1 — Build the node package and pack it as a real npm tarball

From the repo root:

```bash
cd packages/n8n-nodes-relay
pnpm install
pnpm run build      # tsc -p tsconfig.json && node scripts/copy-assets.mjs — package.json:40
pnpm test           # optional sanity check: should still be 14/14 before you go further
npm pack            # produces n8n-nodes-relay-0.1.0.tgz in this directory
```

`npm pack` (not a pnpm-workspace path or symlink) is deliberate: the tarball is a
self-contained real npm artifact, so installing it into a scratch folder outside the
pnpm workspace behaves exactly like installing a published package would. Confirm the
tarball exists and note its absolute path — you'll need it in Step 3.

`package.json:27-29` restricts what ships to `"files": ["dist"]`, and `package.json:30-38`
declares `dist/credentials/RelayIngestApi.credentials.js` and
`dist/nodes/Relay/Relay.node.js` as the `n8n` package's credential/node entry points — this
is the same `n8n` field n8n itself reads on any package (published or local) to discover
what to load, so a successful `npm pack` + build here is what n8n's loader depends on.

## Step 2 — Stand up a real local n8n instance (Docker)

This exact command is copied from n8n's current official docs — verified live via web
fetch of `https://docs.n8n.io/deploy/host-n8n/install-options/install-with-docker` during
this session, so it is not the older/unverified `docker run -it --rm -p 5678:5678
n8nio/n8n` form some tutorials still show (note the image is under `docker.n8n.io/`, not
bare `n8nio/`):

```bash
docker volume create n8n_data

docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -e GENERIC_TIMEZONE="Europe/London" \
  -e TZ="Europe/London" \
  -e N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true \
  -e N8N_RUNNERS_ENABLED=true \
  -v n8n_data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n
```

Don't run this yet if you're following the steps in order — Step 3 adds one more `-v`
flag to the same command. Wait for the log line that says n8n is ready, then open
`http://localhost:5678` and complete the first-run owner-account screen once you get
there (after Step 3's container is up).

## Step 3 — Install the local package into that instance

n8n's own docs for this (verified live via web fetch of
`https://docs.n8n.io/connect/create-nodes/test-your-node/run-your-node-locally` during
this session) describe `npm link` into `~/.n8n/custom` (overridable via
`N8N_CUSTOM_EXTENSIONS`) for a **non-Docker** install, and say explicitly that Docker
container deployment isn't covered by that page. The approach below is this session's own
combination of that mechanism with the container's documented data-volume path
(`/home/node/.n8n`, same doc as Step 2) — **it is inferred, not itself an n8n-published
recipe, so treat it as the first thing to question if loading fails** (see "Failure
modes").

On the host, build a scratch custom-nodes folder and install the tarball from Step 1 into
it with real npm (not pnpm) semantics:

```bash
mkdir -p /tmp/n8n-relay-smoketest/custom
cd /tmp/n8n-relay-smoketest/custom
npm init -y
npm install /absolute/path/to/coreframe-relay/packages/n8n-nodes-relay/n8n-nodes-relay-0.1.0.tgz
```

Expect an `npm warn` about the unmet `n8n-workflow` peer dependency — that's normal and
not a failure; n8n's own runtime provides `n8n-workflow`, the package doesn't need to
bundle it (see `package.json:45-47`).

Now run the container from Step 2, with one extra volume mounting this custom folder to
n8n's default custom-nodes path inside the container:

```bash
docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -e GENERIC_TIMEZONE="Europe/London" \
  -e TZ="Europe/London" \
  -e N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true \
  -e N8N_RUNNERS_ENABLED=true \
  -v n8n_data:/home/node/.n8n \
  -v /tmp/n8n-relay-smoketest/custom:/home/node/.n8n/custom \
  docker.n8n.io/n8nio/n8n
```

Open `http://localhost:5678`, finish the owner setup if this is a fresh `n8n_data`
volume, create a new workflow, and add a node. Search for **Relay** (the node's own name,
`Relay.node.ts:40` — all bare `Relay.node.ts`/`RelayIngestApi.credentials.ts` references
below are shorthand for the real source paths,
`packages/n8n-nodes-relay/src/nodes/Relay/Relay.node.ts` and
`packages/n8n-nodes-relay/src/credentials/RelayIngestApi.credentials.ts` — not the npm
package name, per n8n's own docs above: "search for your nodes by their individual node
names"). If it doesn't appear, see "Failure modes" before
concluding the package is broken.

## Step 4 — Get a real Relay ingest URL

In your Relay dashboard: **Buffer → Routes → New Route** (per
`docs/integrations/n8n.md`, "Setup, step by step", steps 1-3, and
`RelayIngestApi.credentials.ts:34-37`). For the Destination field, use anything
publicly reachable that will visibly answer — `https://webhook.site/<your-unique-url>`
is the simplest, since it needs no n8n webhook of its own and lets you see the forwarded
request land on the destination side too, which is a second independent confirmation.
Do not use `localhost` or a Docker-internal hostname as the destination — Relay's
anti-SSRF check rejects loopback/private addresses (`docs/integrations/n8n.md`, "Before
you start" section), so a `localhost` destination will fail with a 502 unrelated to
whether this node works.

Copy the full ingest URL from the wizard's last step:
`https://<relay-proxy-host>/in/<team-slug>/<route-slug>/<ingest-token>`. Treat it as a
secret.

## Step 5 — Configure the credential and node, then trigger it

1. In n8n, create a **Relay Ingest URL** credential (`RelayIngestApi.credentials.ts:24`),
   paste the ingest URL into the **Ingest URL** field, and click **Test**. This alone
   sends one real request tagged `x-relay-event: test`
   (`RelayIngestApi.credentials.ts:53-67`) — record whether n8n reports the credential
   test as successful. This is your first piece of evidence, but not sufficient alone
   (it proves the credential's `test` block works, not the node's own `execute()` path).
2. Add a **Manual Trigger** node, connect it to a **Relay** node, select the credential
   you just made.
3. Leave **Body** as "Entire Input Item," turn on **Mark As Test Request** (so this run
   is also tagged `x-relay-event: test` and doesn't count as production traffic in
   Relay's log — `Relay.node.ts:84-91`), and execute the workflow (the play button, or
   "Execute Workflow").

## Step 6 — What to actually record as evidence

Do not accept "it didn't error" as evidence. Record all of the following, and paste them
into RELAY-109's tracker entry in `growth/product/relay-sprint-plan.md` (do not edit that
file as part of this runbook itself — that update is the director's own step once the run
is done):

1. **The node's own output pane in n8n**, showing `ok: true`, an HTTP `statusCode` of
   `200`, and a `status: "queued"` plus a `requestId` field
   (`apps/proxy/src/routes/ingest.ts:490` — this exact shape is what a successful ingest
   returns; `Relay.node.ts:170-177` is what puts it in the node's output).
2. **The matching row in Relay's own Delivery Log** (Buffer → Live Delivery Log, filtered
   to this route) for the same `requestId` — confirm it shows the **TEST** badge (not a
   silent gap in the log) and a QUEUED/DELIVERED status
   (`docs/integrations/n8n.md`, "What you'll see once it's live"). The `requestId` from
   the node's output is also carried end-to-end as the `relay-request-id` response header
   (`apps/proxy/src/middleware/requestId.ts:5`), so it's the reliable join key between the
   n8n side and the Relay side — screenshot or copy both `requestId` values side by side
   as the paste-in evidence.
3. **If you used webhook.site as the destination**: the request actually arriving there,
   as a second, independent confirmation that Relay forwarded it (not required if you'd
   rather rely solely on #1 and #2, but cheap to get and removes any doubt that Relay's
   own log is self-reporting).

That combination — n8n's own success output, a correlating Delivery Log row by
`requestId`, in each case captured as a copy-pasteable value or screenshot — is what
"processed by Relay's ingest endpoint" means as evidence, not merely the absence of a red
error in the n8n canvas.

## Failure modes: how to tell a real bug from a config mistake

| Symptom | Most likely cause | How to confirm |
|---|---|---|
| "Relay" doesn't appear in the node search panel at all | The custom-folder volume mount (Step 3) didn't work, not a package bug. `npm install` may have failed silently, or n8n isn't reading `/home/node/.n8n/custom` | `docker exec -it n8n ls -la /home/node/.n8n/custom/node_modules/n8n-nodes-relay/dist` — if this path doesn't exist inside the container, the mount or `npm install` is the problem, not the node code. Also check `docker logs n8n` for a loader error mentioning `n8n-nodes-relay` at startup. |
| Credential **Test** fails immediately with a network error, not an HTTP status | The ingest URL was mistyped, or the Docker container has no outbound internet access | Confirm the same URL works from `curl` on the host first, outside n8n entirely |
| Node throws "does not look like a Relay ingest URL" (`Relay.node.ts:127-133`) | Config mistake — pasted the dashboard/route-list URL instead of the ingest URL from the wizard's last step | Not a bug: this check (`isLikelyIngestUrl`, `Relay.node.ts:200-202`) is deliberately loose and exists exactly to catch this; go back to Step 4 |
| Node output shows `ok: false` with a 404 message | Real per-run config issue: route deleted or ingest token rotated since you copied it (`Relay.node.ts:226-230`) — re-copy the URL | Check the route still exists and is Active in the Relay dashboard |
| Node output shows `ok: false` with a 502 message ("rejected the route's configured destination") | You pointed the route's Destination at `localhost` or a Docker-internal address — this is Relay's anti-SSRF check working as intended, not a bug (`docs/integrations/n8n.md`, "Before you start") | Change the route's Destination to a publicly reachable URL (e.g. webhook.site) and retry |
| Node output shows `ok: false` with a 429 message | Real rate limiting, not this node's fault (`Relay.node.ts:233-240`) | Wait for the `retry after Ns` the message reports, then retry |
| Everything above passes but the Delivery Log row never appears | This would be the first genuinely new finding — a real bug, either in this node's request shape or in Relay's own ingest path | Capture the node's raw HTTP response (n8n's "Execute Workflow" output has an option to show full response), the exact ingest URL used (redact the token before sharing), and file it against RELAY-109 rather than assuming it's a local setup mistake — everything before this row in this table has an established non-bug explanation; this one doesn't |

## Cleanup

```bash
docker rm -f n8n
docker volume rm n8n_data
rm -rf /tmp/n8n-relay-smoketest
```

Also rotate or delete the test route in Relay's dashboard once you're done with it, since
its ingest URL was pasted into a local n8n credential during this test.
