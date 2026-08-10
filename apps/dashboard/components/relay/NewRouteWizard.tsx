import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CopyableUrl } from './CopyableUrl';
import { DestinationHeadersEditor, type HeaderDraft } from './DestinationHeadersEditor';
import type { RouteRow } from './RoutesTable';

/**
 * Names the route-creation API accepts for customer destination auth headers. [RELAY-59]
 * This MIRRORS the server's allowlist — a duplicate for the wizard to offer. The
 * server is the only enforcer; if the two drift the server rejects and this string
 * is where an operator looks.
 */
const ALLOWED_HEADER_NAMES: ReadonlyArray<string> = [
  'authorization',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-signature',
  'x-hmac-signature',
  'x-webhook-secret',
  'x-github-hook-secret',
];

/**
 * "New Route" 3-step wizard — [RELAY-6].
 *
 * DEVIATION from relay-ui-ux-spec.md §3.2, which describes FOUR steps (name →
 * destination → retry policy → copy URL). The ticket's acceptance criterion specifies
 * three (Name → Destination → Get Relay URL), so retry policy moves onto the destination
 * step where it is one number rather than a screen of its own. The spec's backoff step
 * chart is not built; a slider with no visualisation would be a worse version of both.
 */

type Step = 1 | 2 | 3;

/** Mirrors models/route.ts slugifyRouteName so the preview matches what the server does. */
function previewSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function NewRouteWizard({
  open,
  onOpenChange,
  teamSlug,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamSlug: string;
  onCreated: (route: RouteRow) => void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [maxRetries, setMaxRetries] = useState(7);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<RouteRow | null>(null);
  // [RELAY-59] Destination auth headers. Values are collected here and SENT with the
  // create call, never stored in React state past the submit. Reveal flags index the
  // visible rows on this render; clearing the form clears them.
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);
  const [revealedHeaderRows, setRevealedHeaderRows] = useState<ReadonlySet<number>>(
    new Set()
  );

  const slug = previewSlug(name);
  const canAdvance = step === 1 ? slug.length > 0 : isHttpUrl(destination);

  const reset = () => {
    setStep(1);
    setName('');
    setDestination('');
    setMaxRetries(7);
    setError(null);
    setCreated(null);
    setSubmitting(false);
    setHeaders([]);
    setRevealedHeaderRows(new Set());
  };

  const close = (next: boolean) => {
    onOpenChange(next);
    // Reset only after the dialog has animated out, so the content does not visibly
    // snap back to step 1 while closing.
    if (!next) setTimeout(reset, 180);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      // [RELAY-59] headers rides the SAME create call so the wizard cannot forget to
      // encrypt them, and an empty array on the wire means "no auth" not "leave the
      // previous values alone". The server validates and encrypts before the row is
      // touched.
      const payload: Record<string, unknown> = {
        name: name.trim(),
        destination: destination.trim(),
        maxRetries,
      };
      if (headers.length > 0) {
        payload.destinationHeaders = Object.fromEntries(
          headers
            .filter((h) => h.name.trim() && h.value.trim())
            .map((h) => [h.name.trim().toLowerCase(), h.value])
        );
      }

      const res = await fetch(`/api/teams/${teamSlug}/relay/routes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        // Surface the server's message. The server owns rules the client cannot know —
        // reserved slugs, per-team uniqueness — and inventing a generic message here
        // would hide exactly the part the user needs to act on.
        throw new Error(json?.error?.message || 'Could not create the route.');
      }
      setCreated(json.data);
      onCreated(json.data);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the route.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 3 ? 'Your route is live' : 'New route'}
          </DialogTitle>
          <DialogDescription>
            {step === 1 && 'Name it after the service that will send the webhooks.'}
            {step === 2 && 'Where should Relay forward the payloads once it has them?'}
            {step === 3 && 'Point your provider at this URL and Relay takes it from there.'}
          </DialogDescription>
        </DialogHeader>

        {/* Progress. aria-hidden because the step is already announced in the title. */}
        <div className="flex gap-1.5" aria-hidden="true">
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className={`h-1 flex-1 rounded-full ${n <= step ? 'bg-primary' : 'bg-muted'}`}
            />
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-3 py-2">
            <Label htmlFor="route-name">Route name</Label>
            <Input
              id="route-name"
              value={name}
              autoFocus
              placeholder="Stripe events"
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canAdvance && setStep(2)}
            />
            <p className="font-mono text-xs text-muted-foreground">
              {slug ? (
                <>
                  URL will end in <span className="text-foreground">/{slug}</span>
                </>
              ) : (
                'Needs at least one letter or digit.'
              )}
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="route-destination">Destination URL</Label>
              <Input
                id="route-destination"
                value={destination}
                autoFocus
                placeholder="https://n8n.example.com/webhook/abc"
                onChange={(e) => setDestination(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && canAdvance && submit()}
              />
              {destination && !isHttpUrl(destination) && (
                <p className="text-xs text-red-400">Must be an http(s) URL.</p>
              )}
            </div>

            <DestinationHeadersEditor
              value={headers}
              onChange={setHeaders}
              allowedNames={ALLOWED_HEADER_NAMES}
              revealedRows={revealedHeaderRows}
              onToggleReveal={(index) =>
                setRevealedHeaderRows((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })
              }
            />

            <div className="space-y-2">
              <Label htmlFor="route-retries">Max retries</Label>
              <Input
                id="route-retries"
                type="number"
                min={1}
                max={10}
                value={maxRetries}
                onChange={(e) =>
                  setMaxRetries(Math.min(10, Math.max(1, Number(e.target.value) || 7)))
                }
              />
              <p className="text-xs text-muted-foreground">
                After this many failed attempts the payload moves to the dead letter queue
                rather than being dropped.
              </p>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        )}

        {step === 3 && created && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm text-green-400">
              <Check className="h-4 w-4" aria-hidden="true" />
              <span>Route created</span>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Your relay URL
              </p>
              <CopyableUrl url={created.relayUrl} className="text-sm" />
            </div>
            <p className="text-xs text-muted-foreground">
              Nothing is delivered until your provider posts to it. The delivery log will
              show attempts as they arrive.
            </p>
            <p className="text-xs text-muted-foreground">
              The URL is the credential — the last path segment is the route&apos;s ingest
              token ([RELAY-57]), accepted by Stripe, Shopify, GitHub and Meta because
              none of them need to set a custom header. If it leaks, rotate it from the
              Routes table; the old URL stops working immediately.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          {step === 2 ? (
            <Button variant="ghost" size="sm" onClick={() => setStep(1)} disabled={submitting}>
              <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Back
            </Button>
          ) : (
            <span />
          )}

          {step === 1 && (
            <Button size="sm" onClick={() => setStep(2)} disabled={!canAdvance}>
              Next <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          {step === 2 && (
            <Button size="sm" onClick={submit} disabled={!canAdvance || submitting}>
              {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />}
              Create route
            </Button>
          )}
          {step === 3 && (
            <Button size="sm" onClick={() => close(false)}>
              Done
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
