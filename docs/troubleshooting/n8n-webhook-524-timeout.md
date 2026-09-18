---
title: "n8n webhook 524 timeout: the 100-second ceiling, and which of the three fixes to use"
metaTitle: "n8n webhook 524 timeout — the three fixes compared | Coreframe Relay"
description: "n8n Cloud cuts a webhook response at 100 seconds with a 524, but the execution keeps running. Respond Immediately, two webhooks, or an ack in front: compared."
slug: n8n-webhook-524-timeout
canonical: https://relay.coreframe-labs.dev/docs/troubleshooting/n8n-webhook-524-timeout
datePublished: 2026-09-18
dateModified: 2026-09-18
n8nVersionVerified: "2.39.8"
verifiedOn: 2026-09-18
verifiedBy: "Coreframe Labs"
targetQueries:
  - n8n webhook 524 timeout
  - n8n cloud 100 second webhook timeout
pillar: /docs/integrations/n8n
relatedTroubleshooting:
  - n8n-workflow-deactivates-itself
---

A 524 from an n8n Cloud webhook means Cloudflare closed the connection because n8n had not answered within 100 seconds; it does not mean the workflow failed. Confirm it by opening the execution behind the failed request: Succeeded (or still Running) past 100 seconds, while the caller got an HTML error page with a Cloudflare Ray ID, is this problem and nothing else. The fix is to stop holding the HTTP response open while the work runs, and the three ways of doing that have different duplicate-execution behaviour, which no other page on this search covers.

Last verified against n8n 2.39.8 on 2026-09-18. Every link here was re-read on that date.

## The symptom

The Production Webhook URL of a workflow that finishes in the editor answers the real caller with a 524 instead of the workflow's output. The body is Cloudflare's HTML error page with a Ray ID, not JSON, and the cut-off lands at the same point every time.

Both ranking reports have that shape. In [GitHub #18368](https://github.com/n8n-io/n8n/issues/18368) (opened 2025-08-14, closed 2025-10-07 as completed, checked 2026-09-18), a public chat workflow with an AI Agent and a Microsoft SQL node took roughly 1.7 minutes and got `POST .../webhook/<id>/chat 524`. The reporter's own words are the diagnosis: "In n8n, it appears as Succeeded, but in production I receive an HTML code instead of the agent's reply." An n8n maintainer opened an internal ticket (GHC-3766) and asked how long the run took; no code change followed, and the issue was closed for inactivity. In [community.n8n.io/t/…171701](https://community.n8n.io/t/webhook-cut-off-after-100-s-on-n8n-cloud-cloudflare-timeout-what-s-the-fix/171701) (opened 2025-08-19 on a Cloud Team plan, last reply 2025-08-20, no marked solution, checked 2026-09-18), a three-minute workflow was cut "after exactly 100 seconds". Neither is a bug. Both are the documented limit.

## The one check

Open Executions, find the run matching the timestamp of the 524, and read two things:

- **Status and duration.** Succeeded or Running, at or past 100 seconds, means n8n did the work and Cloudflare gave up waiting. That is what #18368's reporter documented, and it is the whole cause.
- **Whether an execution exists at all.** None means the request never reached a running workflow. That is a different failure (an inactive workflow answers 404, not 524) and belongs on the page for a [workflow that deactivates itself](/docs/troubleshooting/n8n-workflow-deactivates-itself).

An Error status under 100 seconds is not this page either; it is whatever the failing node says.

## Root cause, as n8n documents it

n8n's own [common issues page for the Webhook node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/common-issues/) (checked 2026-09-18) states it in one paragraph: "n8n Cloud uses Cloudflare to protect against malicious traffic. If your webhook doesn't respond within 100 seconds, the incoming request will fail with a 524 status code." The limit is on the Cloud edge, not on the workflow engine, so the execution carries on after the caller has been told 524. There is no plan setting to raise it.

So you do not chase it: Cloudflare's [own 524 page](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/) (checked 2026-09-18) gives a default of 125 seconds, adjustable only on Enterprise. n8n's 100 seconds is the number that governs its Cloud and the one both reporters measured. Self-hosted behind your own Cloudflare zone, the 125-second figure applies; behind a plain reverse proxy, the proxy's read timeout does, usually as a 504.

## The three fixes, and what each does to duplicates

The Webhook node's default is **Respond: When Last Node Finishes**, which is why a slow workflow holds the connection open. Left there, a 524 has an ugly side effect: the caller saw a failure, n8n saw a success. A sender that retries on a non-2xx posts the same event again, the retry hits the same wall, and every attempt runs the workflow once more with none ever acknowledged. That is how a 524 becomes a duplicated refund. All three fixes stop the timeout; only two suit a third-party sender.

### Fix 1: Respond Immediately

Set the Webhook node's Respond option to **Immediately**. Per n8n's [Webhook node docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/) (checked 2026-09-18), the node "returns the response code and the message Workflow got started", then the rest of the workflow runs with no connection waiting on it. The caller gets a 200 in milliseconds however long the run takes.

Duplicate behaviour: none from the sender, because the sender is always acknowledged. The risk moves the other way. If the execution fails after the ack, nobody is told and nothing retries, so a failed run is a lost event unless the workflow's own error handling catches it. Use it whenever the caller does not need data computed during the run, which is every Stripe, Shopify and GitHub webhook. To set the status code or body yourself, use **Respond: Using 'Respond to Webhook' Node** with a [Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/) node placed before the slow nodes; it responds once per execution and the workflow continues past it.

### Fix 2: Two webhooks, with polling

The pattern n8n's common-issues page recommends: "One webhook to start the long-running process and send an immediate response. A second webhook that you can call at intervals to query the status of the process and retrieve the result once it's complete." The start webhook is Fix 1 plus a job identifier in the ack; the second reads status keyed on it.

Duplicate behaviour: as Fix 1 on the start leg, and the polling leg is a read, so polling twice is harmless. The constraint is who the caller is. A poll loop needs a client you control, such as the chat front end in #18368. Stripe will not poll you. For third-party senders this buys nothing over Fix 1 and adds an endpoint to keep alive.

### Fix 3: An acknowledging buffer in front of n8n

Put something between the sender and the Production Webhook URL that stores the request, answers the sender 200 at once, and forwards to n8n on its own connection with its own timeout and retries. The 100-second limit still applies to that forward; the sender's delivery is simply no longer the thing that fails.

Duplicate behaviour: this is the one that can create duplicates. If the forwarder's timeout expires, it cannot know whether the execution completed, and its retry posts the same event to a workflow that may already have run. Fix 3 alone moves the duplicate risk from the sender to the forwarder; Fix 3 with Fix 1 removes it, because n8n answers in milliseconds and no retry has a reason to fire. What Fix 3 adds is the case Fix 1 hides: a run that errors after the ack, or a webhook not listening at all, becomes a logged, retryable delivery instead of silence.

## What you cannot get back

Every 524 that has already happened ran the workflow at least once and told the sender it failed. What happens next is the sender's policy, not n8n's. Before changing the Respond mode, read the sender's delivery log: if it retried, look for duplicate executions of the same event in n8n and reverse their side effects; if it did not, the run that succeeded behind the 524 is your record, and any run that errored is gone unless the sender's dashboard can resend that event. n8n re-fires nothing itself.

## Where Relay fits

Relay is Fix 3, with the caveats above. It does not raise n8n's 100-second ceiling and does not shorten a slow workflow. Its forward to n8n waits 110 seconds by default (`DEFAULT_TIMEOUT_MS` in `lib/relay/forward.ts`, read 2026-09-18), set deliberately past n8n's 100 so a workflow that legitimately uses the whole window gets a real answer rather than an early failure; a forward that still times out goes to RETRYING and then the dead letter queue, where it can be replayed by hand with the original headers. What that does and does not do against n8n's other webhook faults, and why to pair it with Respond Immediately, is in the guide to [putting Relay in front of the n8n Production Webhook URL](/docs/integrations/n8n).

The limits are the ones the [quickstart](/docs/quickstart) and the Terms state: delivery is at-least-once, not exactly-once, so a workflow that is not idempotent can run twice for one event, which is exactly the slow-workflow case above; payloads over 1 MiB are refused with a 413 before they are buffered; payloads between 64KB and 1 MiB are delivered and retried but have no stored body to replay from the DLQ; and there is no SLA, status page or service credit today (Terms §3).
