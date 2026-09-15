import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { RouteRow } from './RoutesTable';

/**
 * "Edit destination" dialog — [RELAY-128].
 *
 * Wires a real client to RELAY-123's `PATCH /api/teams/:slug/relay/routes/:routeId`,
 * which had shipped with zero UI. Follows `NewRouteWizard.tsx`'s own conventions
 * rather than inventing new ones: the same `isHttpUrl` client-side check before a
 * submit is attempted, the same "surface the server's own message verbatim" error
 * handling (the server owns rules the client cannot re-derive — here, the SSRF
 * re-validation's specific rejection reason), and the same shared `Dialog` primitive.
 *
 * No client-side role gate. `pages/teams/[slug]/relay/buffer.tsx`'s own comment states
 * this codebase's convention explicitly: "Access control is NOT here... it lives in
 * the API route." Every other per-row write action in `RoutesTable.tsx` (reveal/copy/
 * rotate) follows the same rule — none of them hide or disable for MEMBER either, they
 * rely entirely on the endpoint's own `throwIfNotAllowed(user, 'team', 'update')` 403.
 * This dialog is a pure client to that same handler, so a MEMBER can open it and type
 * into it, but the PATCH itself 403s exactly the way rotate-token's PATCH-sibling
 * already does — proven by `rbac-member-write-gate.test.ts`'s own
 * "routes/[routeId]/index.ts — PATCH" block (MEMBER: 403, `fetchRoute` never called)
 * and `cross-tenant-isolation.spec.ts`'s "PATCH on another team's routeId" block (404,
 * victim row unchanged) — both already exercise this exact handler, so this UI layer
 * does not re-prove either fact at the API level.
 */
export function EditDestinationDialog({
  open,
  onOpenChange,
  teamSlug,
  route,
  onUpdated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamSlug: string;
  /** The row being edited. Null while no row has been chosen yet. */
  route: RouteRow | null;
  /** Invoked with the server's own updated record — never a client-predicted one. */
  onUpdated: (route: RouteRow) => void;
}) {
  const [destination, setDestination] = useState('');
  const [maxRetries, setMaxRetries] = useState(7);
  const [status, setStatus] = useState<'ACTIVE' | 'PAUSED'>('ACTIVE');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed from the route every time the dialog opens. Keyed on `route?.id` (not just
  // `open`) so clicking "Edit" on a DIFFERENT row while state from a previous open
  // still lingers in these fields can never leak the wrong row's values in.
  useEffect(() => {
    if (open && route) {
      setDestination(route.destination);
      setMaxRetries(route.maxRetries);
      setStatus(route.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE');
      setError(null);
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, route?.id]);

  const trimmedDestination = destination.trim();
  const validUrl = isHttpUrl(trimmedDestination);
  const canSubmit = validUrl && !submitting && route !== null;

  const submit = async () => {
    if (!route) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamSlug)}/relay/routes/${encodeURIComponent(route.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            destination: trimmedDestination,
            maxRetries,
            status,
          }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // [RELAY-128] Surface the endpoint's own message verbatim. For a 422 this IS
        // the specific SSRF rejection reason ("destination rejected: <reason>"), not
        // a generic "something went wrong" — same rule NewRouteWizard.tsx's own
        // create-time error handling already follows for this exact reason.
        throw new Error(json?.error?.message || 'Could not update the route.');
      }
      onUpdated(json.data);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the route.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit destination</DialogTitle>
          <DialogDescription>
            {route ? (
              <>
                Update where{' '}
                <span className="font-mono text-foreground">/{route.slug}</span> forwards
                its payloads.
              </>
            ) : (
              'Update where this route forwards its payloads.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="edit-destination">Destination URL</Label>
            <Input
              id="edit-destination"
              value={destination}
              autoFocus
              placeholder="https://n8n.example.com/webhook/abc"
              onChange={(e) => setDestination(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && canSubmit && submit()}
              disabled={submitting}
            />
            {destination.length > 0 && !validUrl && (
              <p className="text-xs text-red-400" role="alert">
                Must be an http(s) URL.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-max-retries">Max retries</Label>
            <Input
              id="edit-max-retries"
              type="number"
              min={1}
              max={10}
              value={maxRetries}
              onChange={(e) =>
                setMaxRetries(Math.min(10, Math.max(1, Number(e.target.value) || 1)))
              }
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              After this many failed attempts the payload moves to the dead letter queue.
            </p>
          </div>

          <div className="space-y-2">
            <Label id="edit-status-label">Status</Label>
            <div
              className="flex gap-1"
              role="group"
              aria-labelledby="edit-status-label"
            >
              <Button
                type="button"
                size="sm"
                variant={status === 'ACTIVE' ? 'secondary' : 'ghost'}
                aria-pressed={status === 'ACTIVE'}
                onClick={() => setStatus('ACTIVE')}
                disabled={submitting}
              >
                Active
              </Button>
              <Button
                type="button"
                size="sm"
                variant={status === 'PAUSED' ? 'secondary' : 'ghost'}
                aria-pressed={status === 'PAUSED'}
                onClick={() => setStatus('PAUSED')}
                disabled={submitting}
              >
                Paused
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              A paused route answers 404 to new webhooks until it is resumed — it does
              not queue them for later.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={!canSubmit}>
            {submitting && (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Mirrors `NewRouteWizard.tsx`'s own check exactly — same rule, same failure mode. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
