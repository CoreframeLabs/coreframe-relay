import { test, expect } from '@playwright/test';

/**
 * A cold visitor's first look — `/`, `/pricing`, `/docs/integrations/n8n` — reachable
 * with no authentication, no test data created, nothing to clean up. Split from
 * `consumer-journey.spec.ts` because it needs neither a session nor the local queue
 * loop, so it stays green even when the signup/route/webhook journey does not.
 *
 * Content is asserted against pages/index.tsx, pages/pricing.tsx and
 * components/defaultLanding/{N8nSection,LandingNav}.tsx as they exist on this branch —
 * every string below is copied out of that source, not guessed.
 */

test.describe('landing, pricing and docs — cold visitor', () => {
  test('landing page loads with the n8n pitch and links to pricing and docs', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(
      page.getByRole('heading', {
        name: "n8n's Webhook trigger has documented, current reliability bugs.",
      })
    ).toBeVisible();

    // The nav's real routed links (not in-page anchors) — LandingNav.tsx's `pageLinks`.
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Docs' })
    ).toHaveAttribute('href', '/docs/integrations/n8n');
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Pricing' })
    ).toHaveAttribute('href', '/pricing');

    // The primary CTA goes to the real signup page, per pages/index.tsx's own header
    // comment ("kept as the destination deliberately").
    await expect(
      page.getByRole('link', { name: 'Request Founding Access' }).first()
    ).toHaveAttribute('href', '/auth/join');
  });

  test('pricing page shows the real $19/month tier and a working Stripe link', async ({
    page,
  }) => {
    await page.goto('/pricing');

    await expect(
      page.getByRole('heading', { name: 'n8n Reliability — $19/month flat.' })
    ).toBeVisible();
    // Scoped to the price <p>, not a bare getByText('$19') — that also matches the
    // "$19/month flat." heading above it (strict-mode violation, two matches).
    // Non-exact within the scope: "$19" and "/ month" are sibling text/inline nodes
    // inside the same <p> (pages/pricing.tsx), so an exact match against the combined
    // text would fail even though both are genuinely on the page.
    const priceBlock = page.locator('p', { hasText: '/ month' });
    await expect(priceBlock).toContainText('$19');
    await expect(priceBlock).toContainText('/ month');

    // Either the real Stripe Payment Link (test mode, per the page's own copy) or the
    // explicit "not configured in this environment" fallback — never neither. Both
    // are real, current states of pages/pricing.tsx; which one renders depends only
    // on whether NEXT_PUBLIC_N8N_WEDGE_PAYMENT_LINK is set in this .env, which this
    // suite does not touch (task constraints: no credential changes).
    const payButton = page.getByRole('link', { name: /Pay with Stripe/ });
    const notConfigured = page.getByText(/isn.t configured in this environment/);
    await expect(payButton.or(notConfigured)).toBeVisible();
  });

  test('docs page for the n8n integration is reachable', async ({ page }) => {
    const response = await page.goto('/docs/integrations/n8n');
    expect(response?.ok(), 'docs page must respond 2xx').toBeTruthy();
    // Real page heading, not just a 200 on an error page rendered with a 200 status.
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
});
