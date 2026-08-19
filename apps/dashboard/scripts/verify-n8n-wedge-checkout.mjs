/**
 * n8n-wedge Payment Link — test-mode, end-to-end evidence for the flow. This
 * is EVIDENCE, not a claim: every step below either calls the
 * real Stripe test-mode API or POSTs a Stripe-signature-valid webhook payload
 * to a real running dashboard instance and then reads the real Postgres row
 * back out. Nothing is asserted without a measurement backing it.
 *
 * What this script does NOT do, and why: it does not submit a card number
 * through Stripe's hosted Checkout page. Doing that headlessly would mean
 * driving Stripe.js/the hosted page with a real browser (Playwright), which
 * this script doesn't attempt — see the "Manual click-through" section this
 * script prints at the end for those exact steps with the 4242 test card.
 * Card data must only ever reach Stripe via its own hosted page or Stripe.js,
 * never via a raw API POST from our side, test mode or not — that boundary is
 * the whole reason PCI scope for this app stays at SAQ A, and it stays that
 * way here too.
 *
 * Prerequisites:
 *   - scripts/create-n8n-wedge-price.mjs already run (Product/Price/Payment
 *     Link exist in Stripe test mode).
 *   - `pnpm dev` running in another terminal (dashboard on APP_URL).
 *   - Local Postgres reachable at DATABASE_URL.
 *
 * Run from apps/dashboard:
 *   node --env-file .env scripts/verify-n8n-wedge-checkout.mjs
 */
import { createHmac, randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

const APP_URL = process.env.APP_URL || 'http://localhost:4002';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!SECRET_KEY?.startsWith('sk_test_')) {
  console.error('STRIPE_SECRET_KEY must be a test-mode key (sk_test_...) to run this verification.');
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error('STRIPE_WEBHOOK_SECRET is not set.');
  process.exit(1);
}

const stripe = new Stripe(SECRET_KEY);
const db = new PrismaClient();

let failures = 0;
function assert(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) failures++;
}

// Builds a Stripe-valid webhook signature header exactly the way Stripe's own
// SDK does (t=<timestamp>,v1=<hmac-sha256 of "timestamp.payload">), so
// stripe.webhooks.constructEvent() in pages/api/webhooks/stripe.ts verifies it
// for real — this is the same technique Stripe's own docs recommend for
// testing webhook handlers without a live event.
function signStripePayload(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function main() {
  console.log('=== Step 1: confirm the n8n-wedge Product/Price/Payment Link are real, live Stripe test-mode objects ===\n');

  const { data: products } = await stripe.products.list({ active: true, limit: 100 });
  const product = products.find((p) => p.metadata?.relay_ticket === 'n8n-wedge');
  assert('Product exists in Stripe test mode', !!product);

  const { data: prices } = await stripe.prices.list({ product: product?.id, active: true });
  const price = prices.find((p) => p.lookup_key === 'relay_n8n_wedge_monthly');
  assert('Price exists ($19.00/month USD)', price?.unit_amount === 1900 && price?.currency === 'usd');

  const linkId = price?.metadata?.payment_link_id;
  let link;
  if (linkId) {
    link = await stripe.paymentLinks.retrieve(linkId);
  }
  assert('Payment Link exists and is active', !!link?.active);

  if (link?.url) {
    const res = await fetch(link.url, { redirect: 'manual' });
    assert(`Payment Link URL resolves (HTTP ${res.status})`, res.status < 500);
  }

  console.log('\n=== Step 2: pick a real team from the local DB to simulate a purchase for ===\n');
  const team = await db.team.findFirst({ where: { slug: 'relay-dev' } });
  assert('A test team exists locally (relay-dev)', !!team);
  if (!team) {
    console.error('No team to test against — seed the DB first.');
    process.exit(1);
  }
  console.log(`Using team: ${team.slug} (${team.id}), billingId before test: ${team.billingId ?? '(none)'}`);

  console.log('\n=== Step 3: build a Stripe-shaped checkout.session.completed event, matching a Payment Link purchase for this team ===\n');
  const fakeCustomerId = `cus_test_${randomBytes(8).toString('hex')}`;
  const fakeSessionId = `cs_test_${randomBytes(12).toString('hex')}`;
  const eventPayload = {
    id: `evt_test_${randomBytes(8).toString('hex')}`,
    object: 'event',
    type: 'checkout.session.completed',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: fakeSessionId,
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: team.id,
        customer: fakeCustomerId,
        payment_status: 'paid',
        status: 'complete',
      },
    },
  };
  const payload = JSON.stringify(eventPayload);
  const signature = signStripePayload(payload, WEBHOOK_SECRET);

  console.log(`Synthetic session: ${fakeSessionId}, customer: ${fakeCustomerId}, client_reference_id: ${team.id}`);
  console.log('(This event is a signature-valid SYNTHETIC payload, built the same way Stripe\'s own testing docs');
  console.log(' recommend — it proves the webhook handler\'s logic, not that a real card was charged.)\n');

  console.log('=== Step 4: POST it to the running dashboard\'s real webhook endpoint ===\n');
  let webhookResponse;
  try {
    webhookResponse = await fetch(`${APP_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signature,
      },
      body: payload,
    });
  } catch (err) {
    console.error(`Could not reach ${APP_URL}/api/webhooks/stripe — is \`pnpm dev\` running? (${err.message})`);
    process.exit(1);
  }
  assert(`Webhook endpoint returned 200 (got ${webhookResponse.status})`, webhookResponse.status === 200);

  console.log('\n=== Step 5: also send a bad-signature payload, and confirm it is rejected ===\n');
  const badSigResponse = await fetch(`${APP_URL}/api/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': 't=1,v1=0000000000000000000000000000000000000000000000000000000000000000',
    },
    body: payload,
  });
  assert(`Invalid signature is rejected (got HTTP ${badSigResponse.status}, expected 400)`, badSigResponse.status === 400);

  console.log('\n=== Step 6: read the real Postgres row back and confirm the team is now linked to the paying customer ===\n');
  const updatedTeam = await db.team.findUnique({ where: { id: team.id } });
  assert(
    `Team.billingId now equals the checkout session's customer (${fakeCustomerId})`,
    updatedTeam?.billingId === fakeCustomerId
  );
  assert("Team.billingProvider is 'stripe'", updatedTeam?.billingProvider === 'stripe');

  console.log('\n=== Cleanup: restore the team\'s prior billing fields ===\n');
  await db.team.update({
    where: { id: team.id },
    data: { billingId: team.billingId, billingProvider: team.billingProvider },
  });
  console.log('Restored.');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);

  console.log('=== Manual click-through (the one part this script cannot do headlessly) ===');
  console.log('1. `pnpm dev`, then in another terminal: `stripe listen --forward-to localhost:4002/api/webhooks/stripe`');
  console.log('   (copy the whsec_... it prints into STRIPE_WEBHOOK_SECRET if it differs from the one already in .env)');
  console.log('2. Log into the dashboard, open a team\'s Billing tab — the "Pay with Stripe" card is the Payment Link');
  console.log('   from scripts/create-n8n-wedge-price.mjs, with ?client_reference_id=<team.id> appended.');
  console.log('3. Complete checkout with card 4242 4242 4242 4242, any future expiry, any CVC, any ZIP.');
  console.log('4. Confirm in the `stripe listen` terminal that checkout.session.completed (200) was delivered.');
  console.log('5. Re-query the team row and confirm billingId/billingProvider now point at the real customer:');
  console.log(`   SELECT id, slug, "billingId", "billingProvider" FROM "Team" WHERE slug = '<team-slug>';`);

  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Verification script crashed:', err);
  await db.$disconnect();
  process.exit(1);
});
