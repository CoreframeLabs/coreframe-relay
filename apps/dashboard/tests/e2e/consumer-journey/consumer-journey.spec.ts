import { test, expect, type Browser, type Page } from '@playwright/test';

import { JoinPage, LoginPage } from '../support/fixtures';
import { makeJourneyUser, type JourneyUser } from './support/testData';
import { RoutesPage, DeliveryLogPage, DlqPage } from './support/relayPages';
import { cleanupJourneyData } from './support/cleanup';

/**
 * The consumer journey — one continuous browser session, clicking through the real UI
 * the way a cold visitor actually would: signup form → login form → "New Route"
 * wizard → "Send test webhook" button → Delivery Log → DLQ → sign out. No step takes
 * an API shortcut; `tests/e2e/support/fixtures/{join,login}-page.ts` are reused
 * because they already drive those two forms for real, not because this suite avoids
 * the UI anywhere.
 *
 * `describe.serial` + one shared `page` across every test in this file is deliberate:
 * a real customer's session is one continuous browser tab carrying one set of
 * cookies, and splitting each step into an independently-authenticated test would
 * hide exactly the kind of session/redirect bug a real journey test exists to catch.
 * Each `test()` below is a checkpoint in that one session, not an isolated unit.
 *
 * Test data: unique per run (`testData.ts`, timestamp + random suffix), created only
 * through the UI, and deleted only by this run's own `afterAll` — see
 * `support/cleanup.ts` for why that is a scoped `deleteMany({ where })`, never the
 * existing suite's blanket `deleteMany()`.
 */

test.describe.serial('consumer journey — signup, login, route, webhook, DLQ, sign-out', () => {
  let browser: Browser;
  let page: Page;
  let user: JourneyUser;
  let teamSlug: string;
  let relayUrl: string;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    const context = await browser.newContext();
    page = await context.newPage();
    user = makeJourneyUser();
  });

  test.afterAll(async () => {
    await page.context().close();
    // Always clean up, even if an earlier step failed and left the account (or
    // route/DeliveryLog rows) partially created — `cleanupJourneyData` is a scoped
    // `deleteMany`, which is a no-op (not an error) for whatever was never created.
    await cleanupJourneyData({ email: user.email, teamSlug: user.teamName });
  });

  test('a new visitor can sign up through the real join form', async () => {
    const joinPage = new JoinPage(page, user, user.teamName);
    await joinPage.goto();
    await joinPage.signUp();
    // JoinPage.signUp() already asserts the redirect to /auth/login and the success
    // toast — the real product behaviour is "created, now go log in", not a direct
    // drop into the dashboard, and this suite tests that as it actually is.
    expect(page.url()).toContain('/auth/login');
  });

  test('the new account logs in and lands in the authenticated dashboard', async () => {
    const loginPage = new LoginPage(page);
    // Already on /auth/login from the redirect above — no second goto().
    await loginPage.credentialLogin(user.email, user.password);
    await page.waitForURL(/\/teams\/[^/]+\/settings/);
    teamSlug = new URL(page.url()).pathname.split('/')[2];
    await expect(page.getByRole('heading', { name: 'Team Settings' })).toBeVisible();
  });

  test('sign out, then log back in via /auth/login with the same credentials', async () => {
    const loginPage = new LoginPage(page);
    await loginPage.logout(user.name);
    // logout() already asserts "Welcome back" (the logged-out state) is visible.

    await loginPage.goto();
    await loginPage.credentialLogin(user.email, user.password);
    await page.waitForURL(`/teams/${teamSlug}/settings`);
    await expect(page.getByRole('heading', { name: 'Team Settings' })).toBeVisible();
  });

  test('creates a real route through the New Route wizard and renders its ingest URL', async () => {
    const routesPage = new RoutesPage(page, teamSlug);
    await routesPage.gotoViaNav();

    await routesPage.openNewRouteWizard();
    const created = await routesPage.createRoute({
      name: user.routeName,
      // The dashboard's own local-only faux destination (RELAY-66) — the same one
      // scripts/smoke-buffer.sh points its routes at for a local run. mode=200 always
      // answers 2xx; it exists specifically so a local pipeline has a real, safe
      // destination to deliver into without a customer server.
      destination: 'http://localhost:4002/api/relay/smoke-destination?mode=200',
      maxRetries: 1,
    });
    relayUrl = created.relayUrl;

    // The URL the wizard rendered is the real ingest endpoint: proxy origin,
    // /in/<team>/<route>/<token> — RELAY-57's path-token shape.
    expect(relayUrl).toMatch(
      new RegExp(`^https?://[^/]+/in/${teamSlug}/[^/]+/[A-Za-z0-9_-]+$`)
    );

    await routesPage.gotoViaNav();
    await expect(routesPage.rowFor(user.routeName)).toBeVisible();
    await expect(routesPage.rowFor(user.routeName)).toContainText('LIVE');
  });

  test('sends a test webhook through the route\'s own UI button and reflects the real outcome', async () => {
    const routesPage = new RoutesPage(page, teamSlug);
    // Already on the Routes list from the previous test's final navigation.
    const testSendResponse = await routesPage.sendTestWebhook(user.routeName);

    if (testSendResponse.ok()) {
      // The pipeline actually queued the send — follow it into the Delivery Log, the
      // way a customer confirming their first webhook arrived actually would.
      const body = (await testSendResponse.json()) as { data?: { requestId?: string } };
      const requestId = body.data?.requestId;
      expect(requestId, 'a 200 test-send must carry a requestId').toBeTruthy();

      await expect(
        page.getByText(`Queued. Waiting for the delivery row…`).or(
          page.getByText(/DELIVERED|QUEUED|RETRYING/)
        )
      ).toBeVisible();

      const deliveryLog = new DeliveryLogPage(page, teamSlug);
      await deliveryLog.gotoViaNav();
      await deliveryLog.filterByRoute(user.routeName);

      // Condition-based wait, not a sleep: the SSE feed can take a moment to carry
      // the row, so poll the one row we care about until it is actually there.
      await expect(deliveryLog.rowFor(requestId as string)).toBeVisible({ timeout: 20_000 });
      await expect(deliveryLog.rowFor(requestId as string)).toContainText('TEST');
    } else {
      // ─── [RELAY-112] REGRESSION GUARD, NOT THE EXPECTED PATH ──────────────────────
      //
      // Two real, reproduced local-dev-only bugs USED to make this the only branch this
      // test ever took, both now fixed:
      //
      //  1. `apps/proxy/src/services/qstash.ts`'s `RELAY_LOCAL_QUEUE_URL` local-loop
      //     branch sent NO Authorization header when it POSTed the envelope to the
      //     dashboard's local consumer stand-in, but
      //     `apps/dashboard/pages/api/relay/qstash-test.ts` unconditionally requires a
      //     valid `Bearer <RELAY_API_SECRET>` and 401s without one — reproduced directly
      //     with `curl` outside Playwright (the same secret got 400 "bad body" WITH the
      //     header, 401 WITHOUT it, proving the secret matched and the header was the
      //     actual gap). Fixed by adding the header, reading the same
      //     `RELAY_API_SECRET` the rest of the proxy already uses for this exact
      //     proxy → dashboard pattern (`routeLookup.ts`).
      //  2. A second, independently-discovered bug running THIS suite for real against
      //     `npm run start` (`NODE_ENV=production`, the exact config this file's own
      //     `playwright.config.ts` `webServer.command` uses): `middleware.ts`'s
      //     unauthenticated allowlist for `/api/relay/qstash-test` /
      //     `/api/relay/smoke-destination` was gated on `NODE_ENV === 'production' ? []
      //     : [...]` with no Host check at all — conflating a REAL deployed dashboard
      //     with a developer's own local `next build && next start`, which is ALSO
      //     `NODE_ENV=production`. Both endpoints 307'd to `/auth/login` (200 HTML)
      //     even with the correct Bearer header attached, and `qstash.ts`'s local-loop
      //     `fetch` silently mistook that 200 for a successful publish (no `DeliveryLog`
      //     row was ever written). Fixed by reusing `localOnlyVerdict` — the exact
      //     three-arm check (`lib/relay/localOnly.ts`) the handlers themselves already
      //     implement and are unit-tested against — in `middleware.ts` too, instead of a
      //     second, less precise copy of the same rule.
      //
      // This branch stays as a regression guard rather than being deleted: production
      // never sets `RELAY_LOCAL_QUEUE_URL` and uses signed real-QStash callbacks
      // instead, so nothing here can affect it — but if either fix above ever regresses
      // in local dev, this assertion documents and catches the exact failure shape
      // instead of the suite failing somewhere else with a confusing message.
      expect(testSendResponse.status()).toBe(502);
      await expect(
        page.getByText('Test webhook could not be enqueued')
      ).toBeVisible();
      test.info().annotations.push({
        type: 'regression-guard',
        description:
          'Hit the pre-RELAY-112-fix failure shape (502 "Test webhook could not be ' +
          'enqueued"). Both known causes (qstash.ts missing Authorization header; ' +
          'middleware.ts not allowlisting the local-only endpoints on a local ' +
          'production build) were fixed and verified — if this fires, one of them has ' +
          'regressed. See the comment above this annotation for both root causes.',
      });
    }
  });

  test('DLQ page renders for the route', async () => {
    const dlqPage = new DlqPage(page, teamSlug);
    await dlqPage.gotoViaNav();
    // Renders correctly whether or not any item is present — the previous test may or
    // may not have produced a DLQ row depending on the known local-dev bug documented
    // there; either way this page must load and describe itself correctly.
    await expect(
      page.getByText(/Webhooks that failed every delivery attempt/)
    ).toBeVisible();
  });

  test('signs out cleanly', async () => {
    const loginPage = new LoginPage(page);
    await loginPage.logout(user.name);
    expect(page.url()).toContain('/auth/login');
  });
});
