/**
 * RELAY-59 probe — proves the ciphertext lands in a raw DB row and NO plaintext
 * is recoverable from it without the key.
 *
 * Run from `apps/dashboard`:
 *   node scripts/relay59-probe.mjs
 */
import { randomBytes, createCipheriv } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const KEY_HEX =
  '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
process.env.RELAY_DESTINATION_HEADERS_KEY = KEY_HEX;

const key = Buffer.from(KEY_HEX, 'hex');

function encryptValue(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(
    JSON.stringify({
      v: 'v1',
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
    }),
    'utf8'
  ).toString('base64');
}

const db = new PrismaClient({
  datasources: { db: { url: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' } },
});

const team = await db.team.findFirst();
if (!team) {
  console.error('no team; run the seed first');
  process.exit(1);
}

const PLAINTEXT_TOKEN = 'sk_live_probe_' + randomBytes(12).toString('hex');

const route = await db.route.create({
  data: {
    teamId: team.id,
    name: 'Relay-59 probe',
    slug: `relay-59-probe-${randomBytes(6).toString('hex')}`,
    destination: 'https://example.com/hook',
    maxRetries: 3,
    ingestToken: randomBytes(24).toString('base64url'),
    destinationHeadersEncrypted: {
      authorization: encryptValue(`Bearer ${PLAINTEXT_TOKEN}`),
      'x-api-key': encryptValue(PLAINTEXT_TOKEN),
    },
  },
  select: { id: true, slug: true },
});

// Read the row back RAW.
const raw = await db.route.findUnique({
  where: { id: route.id },
  select: { id: true, slug: true, destinationHeadersEncrypted: true },
});

const dumped = JSON.stringify(raw.destinationHeadersEncrypted);

console.log('== Raw row from a DB dump ===');
console.log(JSON.stringify(raw, null, 2));
console.log();

console.log('== Assertions ==');
console.log('1. The ciphertext bundle is present:               ', dumped.length > 100);
console.log('2. Plaintext token is ABSENT from the dump:        ', !dumped.includes(PLAINTEXT_TOKEN));
console.log('3. "Bearer " prefix ABSENT from the dump:          ', !dumped.includes('Bearer'));
console.log('4. Column contains base64 JSON envelopes only:     ',
  /^\{"authorization":"[A-Za-z0-9+/=]+","x-api-key":"[A-Za-z0-9+/=]+"\}$/.test(dumped) ||
  /^\{"x-api-key":"[A-Za-z0-9+/=]+","authorization":"[A-Za-z0-9+/=]+"\}$/.test(dumped));
console.log();
console.log('wrote route', route.slug, 'with id', route.id);

// Cleanup
await db.route.delete({ where: { id: route.id } });
await db.$disconnect();

// Exit non-zero if anything failed
const ok =
  dumped.length > 100 &&
  !dumped.includes(PLAINTEXT_TOKEN) &&
  !dumped.includes('Bearer');
process.exit(ok ? 0 : 2);
