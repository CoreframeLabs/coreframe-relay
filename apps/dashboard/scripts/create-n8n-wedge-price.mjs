/**
 * n8n-wedge Payment Link setup — creates (idempotently) ONE test-mode Stripe Product, Price,
 * and Payment Link for the n8n-wedge tier: a single flat $19/mo, no metering,
 * no tiers. Pricing point per `growth/product/design-panel/product-owner-revenue-2026-08-19.md`
 * §5 (recommendation, ~$19/mo, below the Hookdeck $39/mo comparable).
 *
 * This is deliberately NOT RELAY-49 (products/prices/Checkout/webhook/Customer
 * Portal/entitlements as a general ladder) — that ticket is unbuilt and bigger.
 * This script creates exactly one product/price/payment-link so a single
 * customer can pay for the n8n tier and have their team marked as paying.
 *
 * SAFETY: refuses to run unless STRIPE_SECRET_KEY is a test-mode key
 * (sk_test_ prefix). This must never touch live Stripe data.
 *
 * Run from apps/dashboard:
 *   node --env-file .env scripts/create-n8n-wedge-price.mjs
 *
 * Idempotent: re-running finds the existing Product (by metadata.relay_ticket)
 * and Price (by lookup_key) instead of creating duplicates, and reuses the
 * Payment Link recorded on the Price's own metadata.
 */
import Stripe from 'stripe';

const secretKey = process.env.STRIPE_SECRET_KEY;

if (!secretKey) {
  console.error('STRIPE_SECRET_KEY is not set. Run with: node --env-file .env scripts/create-n8n-wedge-price.mjs');
  process.exit(1);
}

if (!secretKey.startsWith('sk_test_')) {
  console.error(
    'Refusing to run: STRIPE_SECRET_KEY does not start with sk_test_. ' +
      'This script only ever creates objects in Stripe TEST mode — going live is a separate, ' +
      "director-only decision with the director's own live credentials."
  );
  process.exit(1);
}

const stripe = new Stripe(secretKey);

const APP_URL = process.env.APP_URL || 'http://localhost:4002';

const PRODUCT_NAME = 'Relay — n8n Reliability';
const PRODUCT_DESCRIPTION =
  'Flat monthly tier for the n8n wedge: point your Stripe/Shopify/etc. webhooks at a Relay route, ' +
  "set the route's destination to your n8n workflow's Production Webhook URL, and Relay retries and " +
  'holds deliveries in a DLQ instead of letting them vanish while n8n is down or mid-toggle.';
const LOOKUP_KEY = 'relay_n8n_wedge_monthly';
const AMOUNT_CENTS = 1900; // $19.00 — integer minor units, per this workspace's money-handling discipline
const CURRENCY = 'usd';
const RELAY_TICKET_TAG = 'n8n-wedge';

async function findOrCreateProduct() {
  const { data: products } = await stripe.products.list({ active: true, limit: 100 });
  const existing = products.find((p) => p.metadata?.relay_ticket === RELAY_TICKET_TAG);
  if (existing) {
    console.log(`Found existing Product ${existing.id} ("${existing.name}")`);
    return existing;
  }

  const product = await stripe.products.create({
    name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    metadata: { relay_ticket: RELAY_TICKET_TAG },
  });
  console.log(`Created Product ${product.id} ("${product.name}")`);
  return product;
}

async function findOrCreatePrice(product) {
  const { data: prices } = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  });
  const existing = prices.find((p) => p.lookup_key === LOOKUP_KEY);
  if (existing) {
    console.log(`Found existing Price ${existing.id} (${existing.unit_amount} ${existing.currency}/${existing.recurring?.interval})`);
    return existing;
  }

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: AMOUNT_CENTS,
    currency: CURRENCY,
    recurring: { interval: 'month' },
    lookup_key: LOOKUP_KEY,
    metadata: { relay_ticket: RELAY_TICKET_TAG },
  });
  console.log(`Created Price ${price.id} ($${(AMOUNT_CENTS / 100).toFixed(2)}/month ${CURRENCY.toUpperCase()})`);
  return price;
}

async function findOrCreatePaymentLink(price) {
  const existingLinkId = price.metadata?.payment_link_id;
  if (existingLinkId) {
    try {
      const link = await stripe.paymentLinks.retrieve(existingLinkId);
      if (link.active) {
        console.log(`Found existing Payment Link ${link.id}`);
        return link;
      }
    } catch {
      // fall through and create a new one — the recorded link no longer resolves
    }
  }

  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    after_completion: {
      type: 'redirect',
      redirect: { url: `${APP_URL}/dashboard?n8n_wedge_checkout=success` },
    },
    metadata: { relay_ticket: RELAY_TICKET_TAG },
  });

  await stripe.prices.update(price.id, {
    metadata: { ...price.metadata, payment_link_id: link.id },
  });

  console.log(`Created Payment Link ${link.id}`);
  return link;
}

async function main() {
  console.log('Stripe TEST mode confirmed (sk_test_ prefix). Creating n8n-wedge Product/Price/Payment Link...\n');

  const product = await findOrCreateProduct();
  const price = await findOrCreatePrice(product);
  const link = await findOrCreatePaymentLink(price);

  console.log('\n--- Summary ---');
  console.log('Product ID:      ', product.id);
  console.log('Price ID:        ', price.id);
  console.log('Price:           ', `$${(AMOUNT_CENTS / 100).toFixed(2)}/month ${CURRENCY.toUpperCase()}`);
  console.log('Payment Link ID: ', link.id);
  console.log('Payment Link URL:', link.url);
  console.log('\nNext steps:');
  console.log('1. Add this line to apps/dashboard/.env (never commit the .env file itself):');
  console.log(`   NEXT_PUBLIC_N8N_WEDGE_PAYMENT_LINK=${link.url}`);
  console.log('2. Run `pnpm run sync-stripe` so the dashboard DB picks up the Product/Price');
  console.log('   (this feeds the existing /teams/[slug]/billing "Get Started" button too).');
  console.log('3. See scripts/verify-n8n-wedge-checkout.mjs for test-mode verification.');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
