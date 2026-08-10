import React from 'react';
import { Eye, EyeOff, Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

/**
 * The headers editor used by the New Route wizard. [RELAY-59]
 *
 * Design rule the whole component keeps: the VALUES the customer types are the only
 * thing this editor knows. It never pre-fills from the server, never displays saved
 * values back, and never re-reads them after submit — the API contract is "masked list
 * of names" and nothing more. Editing an existing route comes later (RELAY-64's edit
 * flow); this component is for the initial set only.
 *
 * Two structural decisions:
 *
 *   1. Header NAME is constrained to a small allowlist (the same one the server
 *      enforces). A free-text name field invites typos that then reject at write time
 *      with "not on the allowed list" — selecting from the known set keeps the
 *      wizard from ever submitting a name the server will reject.
 *
 *   2. The VALUE input is a password-style field by default, with an eye toggle per
 *      row. Plain-text fields are where a "show me what I just typed so I know it's
 *      right" need lives; hidden-by-default is where a coworker walking past should not
 *      pick up a bearer token at a glance.
 */

export type HeaderDraft = { name: string; value: string };

type Props = {
  value: HeaderDraft[];
  onChange: (next: HeaderDraft[]) => void;
  /** The names the server accepts. Sourced from the API, not hardcoded here. */
  allowedNames: ReadonlyArray<string>;
  /** Map of row-index → reveal flag, lifted so the parent can reset on close. */
  revealedRows: ReadonlySet<number>;
  onToggleReveal: (index: number) => void;
};

/**
 * Header name validation matches the server's structural rule exactly. Kept separately
 * rather than imported because this interface exists so the wizard can flag an invalid
 * name before the submit dance, not to share logic with the client-side crypto path —
 * the server is the only authority that matters.
 */
function isValidHeaderName(name: string): boolean {
  return /^[a-z0-9-]+$/.test(name) && name.length > 0 && name.length <= 128;
}

const EMPTY_DRAFT: HeaderDraft = { name: 'authorization', value: '' };

export function DestinationHeadersEditor({
  value,
  onChange,
  allowedNames,
  revealedRows,
  onToggleReveal,
}: Props) {
  const addRow = () => {
    // Find the first allowed name not already used, so two "Add header" clicks do not
    // silently queue a duplicate that the server would then reject.
    const used = new Set(value.map((r) => r.name));
    const fresh = allowedNames.find((n) => !used.has(n)) ?? allowedNames[0];
    onChange([...value, { ...EMPTY_DRAFT, name: fresh }]);
  };

  const removeRow = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  const updateRow = (index: number, patch: Partial<HeaderDraft>) => {
    onChange(value.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor="destination-headers">Authentication headers</Label>
        <span className="text-xs text-muted-foreground">
          Sent with every delivery to your destination — never shown again.
        </span>
      </div>

      {value.length === 0 && (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          No auth configured. Most CRMs and internal APIs need{' '}
          <code className="font-mono">Authorization: Bearer …</code> — add one below to
          enable.
        </p>
      )}

      {value.map((row, index) => {
        const revealed = revealedRows.has(index);
        const taken = value.some((r, i) => i !== index && r.name === row.name);
        const nameValid = isValidHeaderName(row.name);
        return (
          <div key={index} className="flex items-center gap-2">
            {/* Name is a select so the UI offers only the names the server will accept.
                A typo here costs a 422 round trip; the select makes it un-typo-able. */}
            <select
              aria-label={`Header name ${index + 1}`}
              className="h-9 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
              value={row.name}
              onChange={(e) => updateRow(index, { name: e.target.value })}
            >
              {allowedNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>

            <div className="relative flex-[2]">
              <Input
                aria-label={`Header value ${index + 1}`}
                type={revealed ? 'text' : 'password'}
                autoComplete="off"
                placeholder={
                  row.name === 'authorization'
                    ? 'Bearer sk_live_…'
                    : row.name === 'x-api-key'
                      ? 'pk_live_…'
                      : 'the credential your destination expects'
                }
                value={row.value}
                onChange={(e) => updateRow(index, { value: e.target.value })}
                className="pr-9 font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-9 w-9"
                onClick={() => onToggleReveal(index)}
                aria-pressed={revealed}
                aria-label={revealed ? 'Hide value' : 'Show value'}
              >
                {revealed ? (
                  <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </Button>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => removeRow(index)}
              aria-label={`Remove header ${index + 1}`}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>

            {(taken || !nameValid) && (
              <p className="text-xs text-red-400" role="alert">
                {taken ? 'Duplicate header name.' : 'Invalid header name.'}
              </p>
            )}
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={addRow}
        disabled={value.length >= 8}
        className="gap-1"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add header
      </Button>
    </div>
  );
}
