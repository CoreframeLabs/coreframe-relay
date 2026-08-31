# [RELAY-48] Bounce and complaint handling — review

**AC under review:** "Bounce and complaint handling reviewed so one bad address cannot
blackhole later sends."

**Verdict up front:** no bounce/complaint handling code exists in this codebase today,
and none needs to be written to close the immediate risk the AC names — Resend already
provides that specific protection, automatically, for free, today. What genuinely does
not exist, and is worth a real future ticket, is *our own visibility* into bounce/
complaint events. This document is that review; it deliberately does not ship a webhook
handler (see "Why not built now" below).

## 1. Current state in this codebase

Grepped the full dashboard app for `bounce`, `complaint`, `suppress`, `email.bounced`,
`email.complained`, and every `pages/api/webhooks/*` and `pages/api/*resend*` path.
Result: **zero matches.** The only two webhook consumers that exist are
`pages/api/webhooks/stripe.ts` and `pages/api/webhooks/dsync.ts` (SSO directory sync) —
there is no `pages/api/webhooks/resend.ts` or equivalent.

Every outbound email in this app (`apps/dashboard/lib/email/send*.ts` — verification,
password reset, team invite, welcome, and this ticket's new DLQ fallback) goes through
the single `sendEmail.ts` transport, which is plain SMTP via nodemailer against
`smtp.resend.com`. `sendEmail.ts` does not inspect Resend's SMTP response beyond
try/catch; there is no code path anywhere that records "this address bounced" or "this
address complained."

Confirmed no `resend` (Resend's own SDK) or `svix` (the signature-verification library
Resend's webhooks require) package is installed anywhere in this monorepo. Building a
webhook handler is not a small addition on top of what exists — it is a new dependency,
a new secret (`RESEND_WEBHOOK_SECRET`), and a new endpoint registered in Resend's own
dashboard, none of which exist yet.

## 2. What Resend actually offers

Per Resend's current docs (fetched this session, not recalled from training data):

- **Webhook events** (configured per-domain in the Resend dashboard, delivered as
  signed Svix messages): `email.sent`, `email.delivered`, `email.delivery_delayed`,
  `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, `email.failed`,
  `email.suppressed`, plus domain/contact/suppression lifecycle events.
- **Signature verification** uses three headers (`svix-id`, `svix-timestamp`,
  `svix-signature`) and either the `svix` npm package directly or
  `resend.webhooks.verify(...)` on the Resend SDK. The raw request body must be used —
  identical constraint to this codebase's existing QStash signature check in
  `pages/api/relay/qstash.ts` (`bodyParser: false`, verify-before-parse).
- **Automatic, platform-level suppression — the important part.** Resend maintains its
  own suppression list per account, **entirely server-side, with no customer webhook or
  code required.** A hard bounce or a spam complaint adds the address to this list
  automatically, and Resend then **skips sending to that address across every domain in
  the account** on every subsequent send attempt, silently, at the API/SMTP layer.
  Suppression reasons recorded: `hard_bounce`, `complaint`, `soft_bounce`,
  `unsubscribe`, `manual`. A full CRUD API exists for listing/adding/removing entries,
  and `suppression.added` / `suppression.removed` are their own webhook events if we
  ever want to observe changes to that list.

## 3. What this means for the AC

The AC's literal concern — "one bad address cannot blackhole later sends" — describes
exactly the failure mode Resend's automatic suppression list exists to prevent, and it
is already active on this account with zero code from us. A repeated hard bounce does
not silently retry forever or damage deliverability for other recipients today: Resend
stops sending to it after the first hard bounce, permanently, until someone explicitly
removes the suppression.

So the specific, narrow harm the AC names is **already mitigated at the platform
level**, and that is a real, verifiable fact about this Resend account today — not an
assumption. What is genuinely missing is not protection, it is **visibility**:

- We have no record, anywhere in our own database or dashboard, of which of our own
  users' addresses are suppressed. A customer whose email hard-bounced (typo'd address,
  a mail server rejecting `coreframe-labs.dev`, a stale inbox) will silently never
  receive another verification email, password reset, or — as of this ticket — DLQ
  fallback email, and neither we nor they will get any signal that this happened. Given
  this product has no support team (stated constraint elsewhere in this codebase), a
  silently-undeliverable account is a real, if narrow, risk.
- No alerting exists for a spam complaint specifically, which is a sender-reputation
  signal worth knowing about proactively (a rising complaint rate on a small sending
  domain like `coreframe-labs.dev` is the kind of thing you want to catch at "one or
  two" rather than discover when Resend or a mailbox provider throttles the whole
  domain).
- `sendEmail.ts` cannot short-circuit an attempt to a known-bad address before the round
  trip to Resend, since it has no local knowledge of the suppression list. Not a
  correctness problem today (Resend still refuses the send correctly on its side, and
  the caller only pays the one wasted round trip, not repeated damage) but worth noting
  as the one small inefficiency this creates.

## 4. Recommendation — scope for a future ticket, not built here

**Why not built now:** the task briefing for this review was explicit that anything
beyond a genuinely trivial, zero-cost fix should be scoped as a future ticket rather
than half-built. A real webhook handler here needs: a new dependency (`svix` or the
`resend` SDK), a new secret provisioned and set in Vercel, and — critically — the
Resend account's webhook UI configured to point at our endpoint, which is an action on
a third-party dashboard, not a code change, and is out of scope for a code-review pass
to just go do. Shipping a partial version (verify-but-do-nothing, or store-without-
alerting) would be worse than not shipping it: it would look like the AC is closed when
the actual value — visibility — would not exist yet.

**Concrete scope for that future ticket** (a real, small, bounded slice — not
"build all of email deliverability"):

1. `pages/api/webhooks/resend.ts` — mirrors the existing
   `pages/api/webhooks/stripe.ts` shape (`bodyParser: false`, verify raw body against
   `RESEND_WEBHOOK_SECRET` via `svix`, 400 on a bad signature, never log the raw
   payload on a verification failure — same discipline `qstash.ts` already follows).
2. Handle exactly two events: `email.bounced` and `email.complained`. On either, write
   one row to a new, small table (e.g. `EmailSuppression { email, reason, eventType,
   createdAt }`) — a local mirror of the fact, not a replacement for Resend's own list
   (Resend's list is still the one that actually stops the send; ours is the one that
   lets US see it and act on it).
3. Fire the existing `lib/slack.ts` internal ops alert (the SAME mechanism already used
   for new-signup and account-lockout notifications) on a complaint specifically —
   reputation risk is the kind of thing a single founder wants to know about same-day,
   not discover in a weekly report.
4. Optional, cheap follow-on: have `sendEmail.ts` check the local table first and skip
   the round trip with a clear log line, purely as a minor efficiency — not required for
   correctness, since Resend already refuses the send.

Explicitly out of scope for that ticket: building any UI for customers to see their own
suppression status, building an unsuppend/appeal flow, or handling any event beyond
these two (the platform's own suppression list already covers `email.suppressed` and
soft bounces without our help).

## 5. Sources

- Resend webhook event types: `https://resend.com/docs/dashboard/webhooks/event-types`
- Resend webhook signature verification: `https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests`
- Resend suppressions (automatic, team-wide, API-manageable): `https://resend.com/docs/dashboard/emails/email-suppressions`
