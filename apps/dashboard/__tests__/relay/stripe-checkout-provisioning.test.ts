/**
 * [2026-08-25] Coverage for the pay-path provisioning bug the business-review checkpoint
 * found: `pages/pricing.tsx` (the PUBLIC landing page's Payment Link, no logged-in team)
 * deliberately does not set `client_reference_id`, so `handleCheckoutSessionCompleted`
 * used to return immediately, linking nothing — a real customer's card was charged and
 * nothing in the product recognised them as a payer.
 *
 * The fix adds an email-match fallback and, for the two cases that can't be resolved
 * automatically (no matching user; a user who belongs to more than one team), logs the
 * miss instead of silently dropping it. This suite proves both the fixed path and the
 * two logged-miss cases, using real mocked model calls rather than a live database —
 * the logic under test is pure branching, not anything that needs Postgres to prove.
 */

import { handleCheckoutSessionCompleted } from 'pages/api/webhooks/stripe';
import { getTeam, getTeams, updateTeam } from 'models/team';
import { prisma } from 'lib/prisma';
import type Stripe from 'stripe';

// Neither the real Stripe SDK client nor env parsing is needed for this handler's own
// branching logic — stubbed out so importing the module under test doesn't require a
// real STRIPE_SECRET_KEY or a fetch implementation in the jsdom test environment.
jest.mock('lib/stripe', () => ({ stripe: {} }));
jest.mock('lib/env', () => ({
  __esModule: true,
  default: { stripe: { webhookSecret: 'whsec_test' } },
}));

jest.mock('models/team', () => ({
  getTeam: jest.fn(),
  getTeams: jest.fn(),
  updateTeam: jest.fn(),
}));

jest.mock('lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
}));

const mockGetTeam = getTeam as jest.Mock;
const mockGetTeams = getTeams as jest.Mock;
const mockUpdateTeam = updateTeam as jest.Mock;
const mockFindUniqueUser = prisma.user.findUnique as jest.Mock;

function makeSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Event {
  return {
    data: {
      object: {
        id: 'cs_test_123',
        customer: 'cus_test_123',
        client_reference_id: null,
        customer_details: { email: null },
        customer_email: null,
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

describe('[stripe webhook] handleCheckoutSessionCompleted — pay-path provisioning', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('links billingId via client_reference_id when present — the existing, authenticated-billing-page path, unchanged', async () => {
    mockGetTeam.mockResolvedValue({ id: 'team-1', slug: 'team-one' });

    await handleCheckoutSessionCompleted(
      makeSession({ client_reference_id: 'team-1' })
    );

    expect(mockGetTeam).toHaveBeenCalledWith({ id: 'team-1' });
    expect(mockUpdateTeam).toHaveBeenCalledWith('team-one', {
      billingId: 'cus_test_123',
      billingProvider: 'stripe',
    });
    expect(mockFindUniqueUser).not.toHaveBeenCalled();
  });

  it('falls back to email match when client_reference_id is absent (the public /pricing page path) and links the single matching team', async () => {
    mockFindUniqueUser.mockResolvedValue({ id: 'user-1', email: 'buyer@example.com' });
    mockGetTeams.mockResolvedValue([{ id: 'team-2', slug: 'team-two' }]);

    await handleCheckoutSessionCompleted(
      makeSession({
        customer_details: { email: 'buyer@example.com' } as Stripe.Checkout.Session.CustomerDetails,
      })
    );

    expect(mockGetTeam).not.toHaveBeenCalled();
    expect(mockFindUniqueUser).toHaveBeenCalledWith({ where: { email: 'buyer@example.com' } });
    expect(mockGetTeams).toHaveBeenCalledWith('user-1');
    expect(mockUpdateTeam).toHaveBeenCalledWith('team-two', {
      billingId: 'cus_test_123',
      billingProvider: 'stripe',
    });
  });

  it('falls back to customer_email when customer_details.email is absent', async () => {
    mockFindUniqueUser.mockResolvedValue({ id: 'user-2', email: 'legacy@example.com' });
    mockGetTeams.mockResolvedValue([{ id: 'team-3', slug: 'team-three' }]);

    await handleCheckoutSessionCompleted(
      makeSession({ customer_email: 'legacy@example.com' })
    );

    expect(mockUpdateTeam).toHaveBeenCalledWith('team-three', {
      billingId: 'cus_test_123',
      billingProvider: 'stripe',
    });
  });

  it('does NOT silently drop a payment with no matching user — logs it instead of guessing', async () => {
    mockFindUniqueUser.mockResolvedValue(null);

    await handleCheckoutSessionCompleted(
      makeSession({
        customer_details: { email: 'stranger@example.com' } as Stripe.Checkout.Session.CustomerDetails,
      })
    );

    expect(mockUpdateTeam).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"no_matching_user"')
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('stranger@example.com')
    );
  });

  it('does NOT guess which team paid when the matched user belongs to more than one — logs it instead', async () => {
    mockFindUniqueUser.mockResolvedValue({ id: 'user-3', email: 'multi@example.com' });
    mockGetTeams.mockResolvedValue([{ slug: 'team-a' }, { slug: 'team-b' }]);

    await handleCheckoutSessionCompleted(
      makeSession({
        customer_details: { email: 'multi@example.com' } as Stripe.Checkout.Session.CustomerDetails,
      })
    );

    expect(mockUpdateTeam).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"user_has_multiple_teams"')
    );
  });

  it('logs (not throws) when a genuinely new customer pays with no account at all', async () => {
    mockFindUniqueUser.mockResolvedValue({ id: 'user-4', email: 'brandnew@example.com' });
    mockGetTeams.mockResolvedValue([]);

    await handleCheckoutSessionCompleted(
      makeSession({
        customer_details: { email: 'brandnew@example.com' } as Stripe.Checkout.Session.CustomerDetails,
      })
    );

    expect(mockUpdateTeam).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"user_has_no_team"')
    );
  });

  it('does nothing at all when Stripe sends no customer id (defensive, not a real path)', async () => {
    await handleCheckoutSessionCompleted(makeSession({ customer: undefined }));

    expect(mockGetTeam).not.toHaveBeenCalled();
    expect(mockFindUniqueUser).not.toHaveBeenCalled();
    expect(mockUpdateTeam).not.toHaveBeenCalled();
  });

  it('falls through to email match when client_reference_id is present but stale/tampered', async () => {
    mockGetTeam.mockRejectedValue(new Error('not found'));
    mockFindUniqueUser.mockResolvedValue({ id: 'user-5', email: 'recovered@example.com' });
    mockGetTeams.mockResolvedValue([{ slug: 'team-recovered' }]);

    await handleCheckoutSessionCompleted(
      makeSession({
        client_reference_id: 'stale-team-id',
        customer_details: { email: 'recovered@example.com' } as Stripe.Checkout.Session.CustomerDetails,
      })
    );

    expect(mockUpdateTeam).toHaveBeenCalledWith('team-recovered', {
      billingId: 'cus_test_123',
      billingProvider: 'stripe',
    });
  });
});
