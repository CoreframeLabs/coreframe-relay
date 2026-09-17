---
title: "n8n workflow deactivates itself: which bug you have, and the check that tells you"
metaTitle: "n8n workflow deactivates itself — diagnosing the cause | Coreframe Relay"
description: "Three known causes by deployment shape: the multi-main activation bug (#27416, changed in n8n 2.17.0), a shared webhook path, or a trigger lost on takeover."
slug: n8n-workflow-deactivates-itself
canonical: https://relay.coreframe-labs.dev/docs/troubleshooting/n8n-workflow-deactivates-itself
datePublished: 2026-09-17
dateModified: 2026-09-17
n8nVersionVerified: "2.39.7"
verifiedOn: 2026-09-17
verifiedBy: "Coreframe Labs"
targetQueries:
  - n8n workflow deactivates itself
  - n8n workflow randomly becomes inactive
pillar: /docs/integrations/n8n
relatedTroubleshooting: []
---

Start with your deployment shape, because the cause differs for each. If you run n8n in queue mode with more than one main instance, you almost certainly hit [GitHub #27416](https://github.com/n8n-io/n8n/issues/27416): a failed activation during startup or a leader change wrote `active = false` to the database, and n8n 2.17.0 changed that behaviour. On a single instance, the database usually still says active, and the fault is either two workflows on the same webhook path or a trigger that was never re-registered. Each branch below has one check that confirms it before you change anything.

Last verified against n8n 2.39.7 on 2026-09-17. Every issue linked here was re-read on that date.

## The symptom

A workflow that was working stops producing executions. Nobody toggled it. One of two things is true:

- **The UI shows it inactive.** You did not do that, and there is no entry in your audit log or publish history explaining it.
- **The UI shows it active, but the Production Webhook URL answers 404 with a "workflow not active" message**, or a Schedule Trigger simply never fires again.

Flipping the toggle off and on fixes it, for a while. That is the pattern in the forum thread that ranks for this search ([community.n8n.io/t/…135206](https://community.n8n.io/t/workflow-deactivates-itself-after-some-time/135206), checked 2026-09-17), and in the older "Not Sustainable" thread ([community.n8n.io/t/…119667](https://community.n8n.io/t/help-needed-webhooks-randomly-stop-require-workflow-toggle-to-resume-not-sustainable/119667), checked 2026-09-17). Neither reached a diagnosis. The GitHub issue below did.

## Branch A — queue mode, more than one main (`N8N_MULTI_MAIN_SETUP_ENABLED=true`)

**What #27416 says** (checked 2026-09-17). Opened 2026-03-23 by a self-hosted operator on n8n 2.12.0 (Kubernetes, PostgreSQL, Redis Cluster, two main pods). Closed as completed by an n8n maintainer on 2026-05-12. The report is code-level, and the fix PR n8n wrote agrees with it: when a workflow failed to activate during a startup pass or a leader takeover, the catch block in `packages/cli/src/active-workflow-manager.ts` wrote `{ active: false, activeVersionId: null }` to the database. Three consequences followed:

1. Any transient failure (the reporter lists a Redis timeout, a brief webhook path conflict, a credential refresh hiccup, a missing community package) permanently unpublished the workflow. The next leader change skipped it, because the startup pass only looks at rows where `activeVersionId IS NOT NULL`.
2. Parent workflows that call the deactivated one through an Execute Workflow node failed their own validation and were deactivated too. The reporter lost 13 workflows in one restart and 10 more, none using the faulty package, on the next leadership change.
3. Nothing was written to `workflow_publish_history` and no `n8n.audit.workflow.deactivated` event was emitted, so the deactivations looked like a human clicking the toggle.

**How to confirm it is this.** Three things line up:

- Your main container logs around the time of a pod restart or leader change contain an activation failure. The reporter's were `Failed to reinstall community package ... Your license does not allow for feat:communityNodes:customRegistry` (the separate startup race in [#27200](https://github.com/n8n-io/n8n/issues/27200), closed 2026-04-09, checked 2026-09-17) and, on the second pod, `Workflow activation failed sub-workflow validation`. Yours may name a credential or Redis instead; the trigger does not matter, the catch block did.
- In Postgres, the affected rows have `active = false` and `"activeVersionId" IS NULL` on `workflow_entity`, with no matching row in `workflow_publish_history` and nothing in log streaming.
- The set of deactivated workflows grows on each restart along Execute Workflow edges, not randomly.

**What fixed it.** n8n 2.17.0 (released 2026-04-13) shipped three related changes, all in its release notes and all confirmed merged (checked 2026-09-17):

- [PR #28110](https://github.com/n8n-io/n8n/pull/28110) — the multi-main retry loop called `add()` without `shouldPublish: false`, so the leader published a message to itself, reported success, and stopped retrying; a second failure then deactivated with no backoff. The PR fixes that and clears queued retries on leader step-down.
- [PR #28117](https://github.com/n8n-io/n8n/pull/28117) — expression-isolate errors now queue the workflow for retry instead of deactivating it.
- [PR #28126](https://github.com/n8n-io/n8n/pull/28126) — activation and deactivation during boot now emit audit events.

**What is still true on current code.** Read against `master` on 2026-09-17: a non-isolate activation error in the leader's handler still writes `active: false, activeVersionId: null`, but it now tears down partially registered webhooks first and emits `n8n.audit.workflow.deactivated` with `activationMode` and `reason`. Startup-pass failures go into a retry queue that doubles from one second up to a 24-hour ceiling; grep for `Issue on initial workflow activation try of ... (startup)`, `Try to activate workflow`, and `Activation of workflow "..." did fail with error: "..." | retry in N seconds`. So on 2.17.0 or later the deactivation is recorded and retried; it is not impossible. Older than 2.17.0 and multi-main: upgrade before anything else. The issue thread has the same behaviour reported on 2.13.1.

A related multi-main bug is still open: [#38010](https://github.com/n8n-io/n8n/issues/38010) (opened 2026-09-07, checked 2026-09-17). A main that takes over leadership while its own startup pass is still running logs `Skipping activation - already in progress for mode: leadershipChange` at `debug` level, and every workflow that pass had already processed keeps its webhooks but loses its Schedule and poll triggers. The database and UI say active; the trigger never fires. Its fix, [PR #38008](https://github.com/n8n-io/n8n/pull/38008), was unmerged on 2026-09-17. Re-saving each affected workflow is the only recovery reported.

From n8n's own docs: multi-main is a paid feature (leader key TTL 10 seconds, checked every 3), only the leader fires schedules, and queue mode over SQLite is not supported. If SQLite is your database, you are not in this branch.

## Branch B — single main, webhook 404s while the UI says active

The most common version of this on one instance is two workflows registering the same webhook path. Since n8n 1.91.0 ([PR #14783](https://github.com/n8n-io/n8n/pull/14783), merged 2025-04-28, checked 2026-09-17), n8n prevents a later activation from taking over a path an active workflow already holds; before it, "the last workflow activated gets control of that path", which is exactly what an n8n staff member asked the "Not Sustainable" reporter to check. n8n's webhook docs still state the rule as one webhook per path and method combination.

**How to confirm it.** List the Webhook trigger paths across every workflow, including inactive ones you might activate later. Any duplicate path and method pair is the cause. Older than 1.91.0, the "lost" workflow is the one activated first.

## Branch C — n8n Cloud, single workflow, no logs

The 135206 thread above is n8n Cloud (Pro plan, two active workflows), UI active, webhook returning 404. It was never resolved there; one later poster traced their own case to a browser tab-suspender extension acting on the workflows page, another to simply upgrading. You have no container logs on Cloud, so the checks above do not apply. Open a support ticket with the workflow ID and the timestamp of the last successful execution, and rule out browser extensions first.

## The webhooks you lost while it was down

n8n does not replay anything it did not receive. While the workflow was inactive, the Production Webhook URL answered 404 and the sender treated that as a failed delivery. What happens next is the sender's policy, not n8n's: check whether your source retries failed deliveries, for how long, and whether its dashboard can resend a specific event. If it does neither, those events are gone, and you reconstruct them from the source system's own records.

## Where Relay fits

A buffer in front of the webhook does not reactivate a deactivated workflow and does not stop any of the bugs above from firing. What it changes is what happens to the requests that arrive while n8n is not listening. If your sender posts to Relay instead of the Production Webhook URL, Relay stores the request, answers the sender 200, and retries the forward to n8n with backoff; anything that exhausts its retries lands in a dead letter queue you can replay by hand, with the original headers, once the workflow is active again. That, and what it cannot do about n8n's other webhook bugs, is in the guide to [putting Relay in front of the n8n Production Webhook URL](/docs/integrations/n8n).

The limits are the ones the [quickstart](/docs/quickstart) and the Terms state: delivery is at-least-once, not exactly-once, so a workflow that is not idempotent can run twice for one event; payloads over 1 MiB are refused with a 413 before they are buffered; payloads between 64KB and 1 MiB are delivered and retried but have no stored body to replay from the DLQ; and there is no SLA, status page or service credit today (Terms §3).
