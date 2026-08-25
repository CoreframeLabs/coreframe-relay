import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Page objects for the Relay Buffer surface (Routes / Delivery Log / DLQ), mirroring
 * the pattern already established by `tests/e2e/support/fixtures/*` (JoinPage,
 * LoginPage) — selectors are role/label-first, matching what a sighted AND a
 * screen-reader user both actually have to work with, never a CSS structural chain.
 *
 * These wrap real product surfaces read directly from source at the time of writing:
 *   components/relay/BufferRoutes.tsx, NewRouteWizard.tsx, RoutesTable.tsx,
 *   SendTestButton.tsx, DeliveryLogFeed.tsx, DeliveryFilters.tsx, DeliveryTable.tsx,
 *   DlqQueue.tsx, components/shared/shell/TeamNavigation.tsx (the "Routes" /
 *   "Delivery Log" / "DLQ" sidebar links this suite clicks through, not `page.goto()`).
 */

export class RoutesPage {
  constructor(
    public readonly page: Page,
    public readonly teamSlug: string
  ) {}

  /** Click through the sidebar the way a signed-in customer actually would. */
  async gotoViaNav() {
    await this.page.getByRole('link', { name: 'Routes' }).click();
    await this.page.waitForURL(`/teams/${this.teamSlug}/relay/buffer`);
    await expect(
      this.page.getByRole('heading', { name: 'Routes', exact: true })
    ).toBeVisible();
  }

  async openNewRouteWizard() {
    await this.page.getByRole('button', { name: 'New Route' }).click();
    await expect(
      this.page.getByRole('heading', { name: 'New route' })
    ).toBeVisible();
  }

  /**
   * Drives all three wizard steps (NewRouteWizard.tsx) and returns the ingest URL
   * rendered on step 3 — read from the DOM, not predicted, so the assertion is on
   * what the server actually returned.
   */
  async createRoute(params: {
    name: string;
    destination: string;
    maxRetries?: number;
  }): Promise<{ relayUrl: string }> {
    // Step 1 — name.
    await this.page.getByLabel('Route name').fill(params.name);
    await this.page.getByRole('button', { name: 'Next' }).click();

    // Step 2 — destination (+ optional retry count).
    await this.page.getByLabel('Destination URL').fill(params.destination);
    if (params.maxRetries !== undefined) {
      await this.page.getByLabel('Max retries').fill(String(params.maxRetries));
    }

    const createResponse = this.page.waitForResponse(
      (r) =>
        r.url().includes(`/api/teams/${this.teamSlug}/relay/routes`) &&
        r.request().method() === 'POST'
    );
    await this.page.getByRole('button', { name: 'Create route' }).click();
    const res = await createResponse;
    expect(res.status(), 'route creation must answer 201').toBe(201);

    // Step 3 — the real ingest URL, read off the CopyableUrl button's full text
    // content (CSS truncates the visible span; textContent() is not truncated).
    await expect(
      this.page.getByRole('heading', { name: 'Your route is live' })
    ).toBeVisible();
    const urlButton = this.page.locator('button[aria-label^="Copy relay URL"]');
    await expect(urlButton).toBeVisible();
    const relayUrl = (await urlButton.locator('span').first().textContent())?.trim();
    if (!relayUrl) throw new Error('Relay URL was not readable from the wizard step 3 DOM.');

    await this.page.getByRole('button', { name: 'Done' }).click();
    await expect(this.page.getByRole('heading', { name: 'New route' })).toBeHidden();

    return { relayUrl };
  }

  /** The routes table row for a given route name, scoped so status/date lookups don't
   *  need a second selector each time. */
  rowFor(routeName: string) {
    return this.page.getByRole('row', { name: new RegExp(routeName) });
  }

  /**
   * Opens the "Send test webhook" popover for a route and clicks "Send to
   * destination" (SendTestButton.tsx) — the real button a customer clicks, POSTing
   * through the route's actual ingest URL via the proxy, not a mock.
   *
   * Returns the raw fetch Response for `.../test-send` so the caller can assert on
   * whatever the pipeline ACTUALLY answered (200 queued, or a real failure) rather
   * than assuming success — this suite's whole point is to measure, not assume.
   */
  async sendTestWebhook(routeName: string) {
    const row = this.rowFor(routeName);
    await row.getByRole('button', { name: 'Send test' }).click();
    await expect(
      this.page.getByRole('dialog', { name: `Send test webhook for ${routeName}` })
    ).toBeVisible();

    const testSendResponse = this.page.waitForResponse(
      (r) => /\/relay\/routes\/[^/]+\/test-send/.test(r.url()) && r.request().method() === 'POST'
    );
    await this.page.getByRole('button', { name: 'Send to destination' }).click();
    return testSendResponse;
  }
}

export class DeliveryLogPage {
  constructor(
    public readonly page: Page,
    public readonly teamSlug: string
  ) {}

  async gotoViaNav() {
    await this.page.getByRole('link', { name: 'Delivery Log' }).click();
    await this.page.waitForURL(`/teams/${this.teamSlug}/relay/buffer/log`);
    await expect(
      this.page.getByRole('heading', { name: 'Delivery Log' })
    ).toBeVisible();
  }

  async filterByRoute(routeName: string) {
    await this.page.getByLabel('Route').selectOption({ label: routeName });
  }

  /** The virtualized feed's row for one request id (DeliveryTable.tsx renders the
   *  full id as a truncated button's `title` and text — `getByRole('row')`'s
   *  accessible name includes both, so a substring match is stable either way). */
  rowFor(requestId: string) {
    return this.page.getByRole('row', { name: new RegExp(requestId) });
  }
}

export class DlqPage {
  constructor(
    public readonly page: Page,
    public readonly teamSlug: string
  ) {}

  async gotoViaNav() {
    await this.page.getByRole('link', { name: 'DLQ' }).click();
    await this.page.waitForURL(`/teams/${this.teamSlug}/relay/buffer/dlq`);
    await expect(
      this.page.getByRole('heading', { name: 'Dead letter queue' })
    ).toBeVisible();
  }
}
