/**
 * @jest-environment node
 */

/**
 * [RELAY-124] End-to-end proof: a real team's DLQ, seeded past the threshold in a
 * real database, produces a real delivered notification.
 *
 * `relay-124-dlq-growth-notify.test.ts` (next door) proves the decision logic with
 * every dependency mocked. This file proves the two things a mocked suite cannot:
 * that `collectRouteDlqHealthMetrics` counts real seeded `DlqItem`/`DeliveryLog` rows
 * correctly through `unscopedPrisma`, and that a real notification is actually
 * delivered off the back of that — not asserted against a mock.
 *
 * TWO TIERS, DELIBERATELY (same shape as `relay-41.test.ts` / `rls.spec.ts` in this
 * same directory)
 * -------------------------------------------------------------------------------
 * Tier 1 — the full flow against a real Postgres database (`DATABASE_URL`), with the
 * email-fallback path exercised for real up to the same boundary RELAY-48's own tests
 * stop at: a real Team/Route/DlqItem/DeliveryLog are created, `notifyDlqGrowthThreshold`
 * runs unmocked and reads them back through `collectRouteDlqHealthMetrics`, and only
 * `sendDlqFallbackEmail` itself is a jest mock — exactly what `relay-48-dlq-notify.test.ts`
 * mocks in this same directory, for the same reason: `sendDlqFallbackEmail` renders
 * through `@react-email/components`' `render()`, which does a dynamic `import()` of an
 * ESM-only dependency that Jest's VM sandbox cannot satisfy without a Node flag this
 * project's test config does not set (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`,
 * confirmed by reproduction while writing this file — not a RELAY-124 regression, a
 * pre-existing constraint RELAY-48's own suite already designed around). Everything
 * upstream of that render call — the real DB read, the real `evaluateDlqHealth`
 * decision, the real `getTeam`/owner-email lookups, the exact args
 * `notifyDlqGrowthThreshold` hands to `sendDlqFallbackEmail` — is real and asserted on.
 *
 * Tier 2 — the same seeded-DB flow, but with `Team.slackWebhookUrl` pointed at a
 * disposable webhook.site token created for this run via webhook.site's own API, and
 * NOTHING mocked: `notifyDlqGrowthThreshold` makes a genuine HTTPS POST through the
 * real `slack-notify` package to a real internet endpoint, and the test confirms
 * delivery two ways — the promise the call returns, and a second, independent read of
 * webhook.site's own request log via its API (not just trusting the first call
 * succeeded). Requires outbound internet and is gated behind an explicit env var
 * (`RELAY_124_WEBHOOK_SITE_TEST=1`) so a sandboxed/offline CI run skips it loudly
 * instead of failing on a network it was never told it would need — same idiom
 * `relay-41.test.ts` uses for its live-database tier. The webhook.site token is
 * deleted in `afterAll` regardless of outcome.
 *
 * Both tiers use `unscopedPrisma` directly — the fixtures are RLS-protected rows
 * (`Route`, `DeliveryLog`, `DlqItem`), and `dlqHealthCheck.ts`'s own module doc
 * explains why the scoped `prisma` export cannot be used outside a `withTeamScope`
 * call here: no session, no `currentTeamId()`. Confirmed harmless against this
 * disposable database: `DATABASE_URL` here has no RLS policies applied (no
 * `relay_app`-role migration run against it), so `unscopedPrisma` and the scoped
 * client would behave identically either way. Cleanup sweeps by slug prefix in
 * `afterAll`, the same pattern `rls.spec.ts` uses, so an interrupted run cannot leave
 * fixtures behind for the next one.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[RELAY-124] live DLQ-growth suite SKIPPED: no DATABASE_URL set. This is the ' +
      'only automated proof that a real seeded DLQ past the threshold produces a ' +
      'real delivered notification.\n'
  );
}

const WEBHOOK_SITE_TEST = process.env.RELAY_124_WEBHOOK_SITE_TEST === '1';
const describeIfWebhookSite = WEBHOOK_SITE_TEST ? describe : describe.skip;

if (!WEBHOOK_SITE_TEST) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[RELAY-124] real-Slack-webhook sub-suite SKIPPED: set ' +
      'RELAY_124_WEBHOOK_SITE_TEST=1 to run it (requires outbound internet to ' +
      'webhook.site). The real-database email-fallback tier above still runs ' +
      'regardless of this flag.\n'
  );
}

jest.mock('../../lib/email/sendDlqFallbackEmail', () => ({
  __esModule: true,
  // The one boundary this suite does not cross — see the module doc above for why
  // (a Jest/ESM dynamic-import incompatibility in `@react-email/components`'s
  // `render()`, the same reason `relay-48-dlq-notify.test.ts` mocks this exact
  // function rather than `sendEmail`). Every dependency above this boundary — the
  // real DB read, the real `evaluateDlqHealth` decision, the real `getTeam` /
  // owner-email lookups — is exercised for real.
  sendDlqFallbackEmail: jest.fn().mockResolvedValue(undefined),
}));

import { unscopedPrisma } from '../../lib/prisma';
import { notifyDlqGrowthThreshold } from '../../lib/relay/dlqNotify';
import { DLQ_GROWTH_ALERT_THRESHOLD } from '../../lib/relay/dlqHealthCheck';
import { sendDlqFallbackEmail } from '../../lib/email/sendDlqFallbackEmail';

const mockedSendEmail = sendDlqFallbackEmail as jest.Mock;

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SLUG_PREFIX = 'relay-124-live-test-';

jest.setTimeout(30_000);

async function seedTeamWithRoute(opts: {
  suffix: string;
  slackWebhookUrl?: string | null;
  ownerEmail?: string;
}) {
  const slug = `${SLUG_PREFIX}${RUN}-${opts.suffix}`;

  const team = await unscopedPrisma.team.create({
    data: {
      name: `RELAY-124 live test (${opts.suffix})`,
      slug,
      slackWebhookUrl: opts.slackWebhookUrl ?? null,
    },
  });

  const route = await unscopedPrisma.route.create({
    data: {
      teamId: team.id,
      name: `route-${opts.suffix}`,
      slug: `route-${opts.suffix}`,
      destination: 'https://api.example.com/hooks/relay?token=shh',
      ingestToken: `relay-124-live-${RUN}-${opts.suffix}`,
    },
  });

  if (opts.ownerEmail) {
    const user = await unscopedPrisma.user.create({
      data: { name: 'RELAY-124 Test Owner', email: opts.ownerEmail },
    });
    await unscopedPrisma.teamMember.create({
      data: { teamId: team.id, userId: user.id, role: 'OWNER' },
    });
  }

  return { team, route };
}

/**
 * Seeds `count` real DlqItem rows and `deliveryLogCount` real DeliveryLog rows for
 * `routeId`, all with `createdAt` inside RELAY-44's trailing window — this is the
 * literal "seed a real team's DLQ past the threshold" the AC asks for, not a
 * hypothetical count.
 */
async function seedDlqGrowth(routeId: string, count: number) {
  const now = new Date();
  await unscopedPrisma.dlqItem.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      routeId,
      requestId: `relay-124-live-${RUN}-req-${i}`,
      failReason: 'destination responded 500',
      attemptCount: 1,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      createdAt: now,
    })),
  });
}

async function cleanupFixtures() {
  // Sweep by prefix, not just this run's own ids — the same defense
  // `rls.spec.ts` documents: a run killed by a harness timeout before cleanup
  // must not leave rows behind for the next one to trip over.
  const teams = await unscopedPrisma.team.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true },
  });
  const teamIds = teams.map((t) => t.id);
  if (teamIds.length === 0) return;

  // Explicit children-first delete: this disposable database has no FK cascade
  // guarantee configured beyond what `prisma db push`/`migrate deploy` created, and
  // being explicit here means a partial migration state cannot silently strand rows.
  const routes = await unscopedPrisma.route.findMany({
    where: { teamId: { in: teamIds } },
    select: { id: true },
  });
  const routeIds = routes.map((r) => r.id);
  if (routeIds.length > 0) {
    await unscopedPrisma.dlqItem.deleteMany({ where: { routeId: { in: routeIds } } });
    await unscopedPrisma.deliveryLog.deleteMany({
      where: { routeId: { in: routeIds } },
    });
  }
  await unscopedPrisma.route.deleteMany({ where: { teamId: { in: teamIds } } });
  await unscopedPrisma.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
  await unscopedPrisma.team.deleteMany({ where: { id: { in: teamIds } } });
  await unscopedPrisma.user.deleteMany({
    where: { email: { startsWith: `relay-124-live-${RUN}` } },
  });
}

describeIfDb('[RELAY-124] real seeded DLQ growth → real notification', () => {
  beforeEach(() => {
    mockedSendEmail.mockClear();
  });

  afterAll(async () => {
    await cleanupFixtures();

    // Confirm the delete actually worked — do not just assume it did.
    const remaining = await unscopedPrisma.team.count({
      where: { slug: { startsWith: SLUG_PREFIX } },
    });
    expect(remaining).toBe(0);

    await unscopedPrisma.$disconnect();
  });

  describe('Tier 1 — no Team.slackWebhookUrl → the real email-fallback path fires', () => {
    it('reads the real seeded rows and sends a real (SMTP-mocked) fallback email', async () => {
      const ownerEmail = `relay-124-live-${RUN}-owner-email@example.com`;
      const { team, route } = await seedTeamWithRoute({
        suffix: 'email',
        slackWebhookUrl: null,
        ownerEmail,
      });

      const seededCount = DLQ_GROWTH_ALERT_THRESHOLD + 7;
      await seedDlqGrowth(route.id, seededCount);

      // Independent, second-channel confirmation that the seed actually landed —
      // read it back directly rather than trusting `createMany`'s return value.
      const actualCount = await unscopedPrisma.dlqItem.count({
        where: { routeId: route.id },
      });
      expect(actualCount).toBe(seededCount);

      const result = await notifyDlqGrowthThreshold({
        teamId: team.id,
        routeId: route.id,
      });

      expect(result).toEqual({
        notified: true,
        channel: 'email',
        reasons: ['dlq_growth_exceeded'],
      });
      expect(mockedSendEmail).toHaveBeenCalledTimes(1);
      const sent = mockedSendEmail.mock.calls[0][0];
      expect(sent.to).toBe(ownerEmail);
      expect(sent.teamName).toBe(team.name);
      expect(sent.routeName).toBe(route.name);
      expect(sent.destinationHost).toBe('api.example.com');
      expect(sent.failReason).toContain(String(seededCount));
      expect(sent.failReason).toContain(String(DLQ_GROWTH_ALERT_THRESHOLD));
    });

    it('does not notify a route whose real DLQ count is below the threshold', async () => {
      const { team, route } = await seedTeamWithRoute({
        suffix: 'below-threshold',
        slackWebhookUrl: null,
      });
      await seedDlqGrowth(route.id, 2);

      const result = await notifyDlqGrowthThreshold({
        teamId: team.id,
        routeId: route.id,
      });

      expect(result).toEqual({ notified: false, channel: null, reasons: [] });
      expect(mockedSendEmail).not.toHaveBeenCalled();
    });
  });

  describeIfWebhookSite(
    'Tier 2 — Team.slackWebhookUrl set to a real disposable endpoint → a real Slack HTTP delivery',
    () => {
      let webhookUuid: string;
      let webhookUrl: string;

      beforeAll(async () => {
        // Real webhook.site API call — this is the "disposable test webhook URL"
        // pattern named in the ticket. Configured to answer the literal body "ok",
        // matching real Slack's own incoming-webhook success contract, since
        // `slack-notify` treats any other response body as a delivery failure.
        const createRes = await fetch('https://webhook.site/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const created = await createRes.json();
        webhookUuid = created.uuid;
        webhookUrl = `https://webhook.site/${webhookUuid}`;

        await fetch(`https://webhook.site/token/${webhookUuid}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ default_content: 'ok', default_status: 200 }),
        });
      });

      afterAll(async () => {
        if (webhookUuid) {
          await fetch(`https://webhook.site/token/${webhookUuid}`, {
            method: 'DELETE',
          }).catch(() => undefined);
        }
      });

      it('delivers a real HTTPS POST to the team webhook, confirmed via webhook.site\'s own request log', async () => {
        const { team, route } = await seedTeamWithRoute({
          suffix: 'slack',
          slackWebhookUrl: webhookUrl,
        });
        const seededCount = DLQ_GROWTH_ALERT_THRESHOLD + 4;
        await seedDlqGrowth(route.id, seededCount);

        const result = await notifyDlqGrowthThreshold({
          teamId: team.id,
          routeId: route.id,
        });

        expect(result).toEqual({
          notified: true,
          channel: 'slack',
          reasons: ['dlq_growth_exceeded'],
        });
        expect(mockedSendEmail).not.toHaveBeenCalled();

        // Second, independent channel: ask webhook.site itself what it actually
        // received, rather than trusting only the promise `notifyDlqGrowthThreshold`
        // returned.
        const requestsRes = await fetch(
          `https://webhook.site/token/${webhookUuid}/requests`
        );
        const requestsBody = await requestsRes.json();
        const requests = requestsBody.data ?? requestsBody;
        expect(Array.isArray(requests)).toBe(true);
        expect(requests.length).toBeGreaterThan(0);

        const latest = requests[0];
        expect(latest.method).toBe('POST');
        const payload = JSON.parse(latest.content);
        const fieldValues: string[] = (
          payload.attachments?.[0]?.fields ?? []
        ).map((f: { value: string }) => f.value);
        expect(fieldValues).toContain(route.name);
        expect(fieldValues).toContain(String(seededCount));
        expect(fieldValues).toContain(String(DLQ_GROWTH_ALERT_THRESHOLD));
      });
    }
  );
});
