import { test, expect, type Browser, type Page } from '@playwright/test';

import { JoinPage, LoginPage } from '../support/fixtures';
import { makeJourneyUser, type JourneyUser } from './support/testData';
import { RoutesPage, DeliveryLogPage } from './support/relayPages';
import { cleanupJourneyData } from './support/cleanup';

/**
 * "Edit destination" through the real UI — [RELAY-128].
 *
 * A SEPARATE file from `consumer-journey.spec.ts`, per this project's own isolation
 * rule (`relay-consumer-e2e-playwright` skill): this suite creates its own unique,
 * timestamped user/team/route and tears down only what it created, so it is safe to
 * run alongside another agent's own suite against the same shared local Postgres.
 * `describe.serial` + one shared `page`, same reasoning as the consumer journey — this
 * IS one continuous real session, not independently-authenticated steps.
 *
 * WHY httpbin.org, STATED HONESTLY: `pages/api/teams/[slug]/relay/routes/[routeId]/
 * index.ts`'s PATCH handler calls `resolveAndValidateDestination` with NO loopback
 * waiver (unlike `forward.ts`'s own `isTest`-gated, port-4002-only waiver for the
 * built-in smoke destination) — confirmed by reading both files, not assumed. That
 * means editing a route's destination to `localhost:4002/api/relay/smoke-destination`
 * (the local-only faux destination `consumer-journey.spec.ts` uses for a NEWLY
 * CREATED route) 422s here, every time, real SSRF enforcement working exactly as
 * designed. Proving "the UI can edit into a destination that then really receives
 * traffic" therefore needs a destination the PATCH handler's real DNS-resolving check
 * will actually accept — a real public host. `httpbin.org/status/<code>` answers
 * exactly the status code in its path with no redirect (confirmed with a bare `curl`
 * before writing this file), which is what turns "did the edited destination actually
 * get used for the next delivery" into a same-call assertion: the delivery pipeline's
 * own re-check at send time (`forward.ts`) hits the SAME real host this test just
 * PATCHed the route to, and the response code echoed back UI-side is the proof.
 */

test.describe.serial('edit destination — real dialog, real PATCH, real delivery to the NEW destination', () => {
  let browser: Browser;
  let page: Page;
  let user: JourneyUser;
  let teamSlug: string;

  const OLD_DESTINATION = 'https://httpbin.org/status/200';
  const NEW_DESTINATION = 'https://httpbin.org/status/500';
  const BLOCKED_DESTINATION = 'http://169.254.169.254/latest/meta-data';

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    const context = await browser.newContext();
    page = await context.newPage();
    user = makeJourneyUser();
  });

  test.afterAll(async () => {
    await page.context().close();
    await cleanupJourneyData({ email: user.email, teamSlug: user.teamName });
  });

  test('signup, login, and create a route pointed at a real reachable destination', async () => {
    const joinPage = new JoinPage(page, user, user.teamName);
    await joinPage.goto();
    await joinPage.signUp();

    const loginPage = new LoginPage(page);
    await loginPage.credentialLogin(user.email, user.password);
    await page.waitForURL(/\/teams\/[^/]+\/settings/);
    teamSlug = new URL(page.url()).pathname.split('/')[2];

    const routesPage = new RoutesPage(page, teamSlug);
    await routesPage.gotoViaNav();
    await routesPage.openNewRouteWizard();
    await routesPage.createRoute({
      name: user.routeName,
      destination: OLD_DESTINATION,
      maxRetries: 1,
    });

    await routesPage.gotoViaNav();
    await expect(routesPage.rowFor(user.routeName)).toBeVisible();
    await expect(routesPage.rowFor(user.routeName)).toContainText('httpbin.org/status/200');
  });

  test('the edit dialog opens pre-filled with the route\'s real current values', async () => {
    const routesPage = new RoutesPage(page, teamSlug);
    const dialog = await routesPage.openEditDestination(user.routeName);

    await expect(dialog.getByLabel('Destination URL')).toHaveValue(OLD_DESTINATION);
    await expect(dialog.getByLabel('Max retries')).toHaveValue('1');
    await expect(dialog.getByRole('button', { name: 'Active' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // Closed via Cancel, not Save — this test asserts pre-fill only, and must leave
    // the row completely unchanged for the next test.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('real client-side validation blocks submit before any network call', async () => {
    const routesPage = new RoutesPage(page, teamSlug);
    const dialog = await routesPage.openEditDestination(user.routeName);

    await dialog.getByLabel('Destination URL').fill('not a url');
    await expect(dialog.getByText('Must be an http(s) URL.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a real SSRF-rejected destination surfaces the endpoint\'s own specific reason, not a generic error', async () => {
    const routesPage = new RoutesPage(page, teamSlug);
    const dialog = await routesPage.openEditDestination(user.routeName);

    const patchResponse = await routesPage.submitEditDestination(dialog, {
      destination: BLOCKED_DESTINATION,
    });
    expect(patchResponse.status(), 'a blocked-range literal address must 422').toBe(422);
    const body = (await patchResponse.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('destination rejected');
    // The SPECIFIC reason, not a paraphrase — read straight from
    // packages/types/src/ssrf.ts's own `isBlockedIPv4` message for this address.
    expect(body.error?.message).toContain('reserved or private range');

    // Surfaced in the dialog itself, verbatim.
    await expect(dialog.getByRole('alert').filter({ hasText: 'destination rejected' })).toBeVisible();
    await expect(dialog.getByRole('alert')).toContainText('reserved or private range');

    // The row must be provably unchanged — a rejected PATCH must not have landed.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(routesPage.rowFor(user.routeName)).toContainText('httpbin.org/status/200');
  });

  test('a real pause/resume edit persists and the row reflects it with no page reload', async () => {
    const routesPage = new RoutesPage(page, teamSlug);
    const dialog = await routesPage.openEditDestination(user.routeName);

    const patchResponse = await routesPage.submitEditDestination(dialog, { status: 'PAUSED' });
    expect(patchResponse.status()).toBe(200);
    const body = (await patchResponse.json()) as { data: { status: string } };
    expect(body.data.status).toBe('PAUSED');

    await expect(dialog).toBeHidden();
    // SWR revalidation, not a navigation — same `mutate()` contract `onRotated`
    // already uses. If this were a full reload the URL below would still match (the
    // page never left /relay/buffer), so the decisive check is that no `page.goto`/
    // `page.reload` call happened anywhere in this test — it didn't — and the row
    // updates in place regardless.
    await expect(routesPage.rowFor(user.routeName)).toContainText('PAUSED');
  });

  test('edits destination AND resumes the route in one real PATCH, row updates in place', async () => {
    const routesPage = new RoutesPage(page, teamSlug);
    const dialog = await routesPage.openEditDestination(user.routeName);

    // Confirms the dialog re-seeded from the route's REAL current (paused) state,
    // not stale values left over from the earlier cancelled attempts above.
    await expect(dialog.getByRole('button', { name: 'Paused' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    const patchResponse = await routesPage.submitEditDestination(dialog, {
      destination: NEW_DESTINATION,
      status: 'ACTIVE',
    });
    expect(patchResponse.status()).toBe(200);
    const body = (await patchResponse.json()) as {
      data: { destination: string; status: string };
    };
    expect(body.data.destination).toBe(NEW_DESTINATION);
    expect(body.data.status).toBe('ACTIVE');

    await expect(dialog).toBeHidden();
    await expect(routesPage.rowFor(user.routeName)).toContainText('httpbin.org/status/500');
    await expect(routesPage.rowFor(user.routeName)).not.toContainText('httpbin.org/status/200');
    await expect(routesPage.rowFor(user.routeName)).toContainText('LIVE');
  });

  test('a real test webhook, sent through the UI, actually lands on the NEW destination', async () => {
    const routesPage = new RoutesPage(page, teamSlug);
    const testSendResponse = await routesPage.sendTestWebhook(user.routeName);
    expect(testSendResponse.status(), 'the test-send must queue').toBe(200);
    const body = (await testSendResponse.json()) as { data?: { requestId?: string } };
    const requestId = body.data?.requestId;
    expect(requestId, 'a 200 test-send must carry a requestId').toBeTruthy();

    // The decisive proof, read from the Delivery Log rather than the popover's own
    // text (whose "Latency" field could coincidentally contain "500" as a substring
    // of a millisecond value — the log's row is the same real DeliveryLog write
    // `relay-123-patch-destination-delivery.test.ts` asserts on at the API layer,
    // just reached through the browser here): `forward.ts`'s OWN re-check at send
    // time resolves this route by id and hits whatever destination is CURRENTLY
    // stored — if the PATCH above had not really persisted, or the edit dialog were
    // a decorative no-op, this send would land on the OLD destination and report
    // 200, not 500.
    const deliveryLog = new DeliveryLogPage(page, teamSlug);
    await deliveryLog.gotoViaNav();
    await deliveryLog.filterByRoute(user.routeName);
    const row = deliveryLog.rowFor(requestId as string);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveText(/\b500\b/);
    await expect(row).not.toHaveText(/DELIVERED/);
  });

  test('signs out cleanly', async () => {
    const loginPage = new LoginPage(page);
    await loginPage.logout(user.name);
    expect(page.url()).toContain('/auth/login');
  });
});
