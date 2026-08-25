/**
 * [RELAY-68] First-party cookie fallback for the anonymous pay-first path.
 *
 * `pages/pricing.tsx`'s "Pay with Stripe" Payment Link deliberately carries no
 * `client_reference_id` (see that page's own top-of-file comment, and
 * `pages/api/webhooks/stripe.ts`'s `handleCheckoutSessionCompleted`) — there is no
 * team yet to attach it to. The same gap applies to marketing attribution: a visitor
 * can land on `/` or `/pricing` from an n8n community post carrying `utm_source=…`,
 * click straight through to Stripe, pay, and only create a Relay account afterward
 * via the Payment Link's post-checkout redirect. By the time they reach
 * `/auth/join`, the join URL itself carries no UTM params at all — the query-string
 * capture in `pages/auth/join.tsx` alone would attribute that signup as "unknown".
 *
 * This cookie closes that gap: `pages/_app.tsx` writes it on every page load that
 * carries `utm_source`/`utm_medium`/`utm_campaign` in the URL — whichever page the
 * visitor actually landed on, not just `/auth/join` — and `pages/auth/join.tsx`
 * reads it back ONLY when the join URL's own query string carries no UTM params, so
 * a direct `/auth/join?utm_source=…` link (some of RELAY-70's drafted content links
 * straight to join) still wins over a stale cookie from an earlier, unrelated visit.
 *
 * Deliberately NOT the channel of record for `isInternal` or any other trust
 * decision — it carries only the three UTM strings, and `pages/api/auth/join.ts`
 * treats whatever arrives in the join POST body (whether sourced from the query
 * string or this cookie) the same way it always has: as free-text attribution
 * metadata, not as anything security-relevant.
 */

const COOKIE_NAME = 'relay_attribution';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days — covers a realistic research-then-buy gap

export type AttributionParams = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
};

function hasAnyValue(params: AttributionParams): boolean {
  return Boolean(params.utm_source || params.utm_medium || params.utm_campaign);
}

/** Writes the cookie only when at least one UTM param is present — a page load with
 * none (the common case, every page view after the first) must never overwrite an
 * earlier, real attribution with a blank one. */
export function writeAttributionCookie(params: AttributionParams): void {
  if (typeof document === 'undefined') return;
  if (!hasAnyValue(params)) return;

  const { utm_source, utm_medium, utm_campaign } = params;
  const value = encodeURIComponent(
    JSON.stringify({ utm_source, utm_medium, utm_campaign })
  );
  document.cookie = `${COOKIE_NAME}=${value}; path=/; max-age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function readAttributionCookie(): AttributionParams | null {
  if (typeof document === 'undefined') return null;

  const row = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${COOKIE_NAME}=`));
  if (!row) return null;

  try {
    const raw = decodeURIComponent(row.slice(COOKIE_NAME.length + 1));
    const parsed = JSON.parse(raw);
    const result: AttributionParams = {
      utm_source:
        typeof parsed.utm_source === 'string' ? parsed.utm_source : undefined,
      utm_medium:
        typeof parsed.utm_medium === 'string' ? parsed.utm_medium : undefined,
      utm_campaign:
        typeof parsed.utm_campaign === 'string' ? parsed.utm_campaign : undefined,
    };
    return hasAnyValue(result) ? result : null;
  } catch {
    // Malformed/tampered cookie value — treat exactly like no cookie at all rather
    // than throwing and breaking the join page.
    return null;
  }
}
