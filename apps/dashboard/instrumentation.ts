// instrumentation.ts

import * as Sentry from '@sentry/nextjs';

// Vercel's Supabase integration injects POSTGRES_PRISMA_URL (the pooled,
// Prisma-shaped connection string) but not DATABASE_URL, which is the only
// name prisma/schema.prisma reads. Fallback only — never overrides an
// explicitly-set DATABASE_URL, so the RELAY-39/G2a cutover to relay_app is
// unaffected once that var is set directly.
if (!process.env.DATABASE_URL && process.env.POSTGRES_PRISMA_URL) {
  process.env.DATABASE_URL = process.env.POSTGRES_PRISMA_URL;
}

export function register() {
  if (
    process.env.NEXT_RUNTIME === 'nodejs' ||
    process.env.NEXT_RUNTIME === 'edge'
  ) {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: parseFloat(
        process.env.NEXT_PUBLIC_SENTRY_TRACE_SAMPLE_RATE ?? '0.0'
      ),
      debug: false,
    });
  }
}
