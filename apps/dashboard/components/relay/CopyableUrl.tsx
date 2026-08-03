import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * Truncated URL with one-click copy, per relay-ui-ux-spec.md §3.2.
 *
 * `navigator.clipboard` is unavailable on insecure origins and can be permission-denied,
 * so the failure path falls back to selecting the text rather than silently doing
 * nothing. A copy button that appears to work and doesn't is worse than no button — the
 * user pastes a stale clipboard into their webhook provider and debugs the wrong thing.
 */
export function CopyableUrl({ url, className }: { url: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 2600);
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={copy}
            className={cn(
              'group inline-flex max-w-full items-center gap-2 rounded-md px-2 py-1',
              'font-mono text-xs text-muted-foreground',
              'hover:bg-muted hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              className
            )}
            aria-label={copied ? 'Copied' : `Copy relay URL ${url}`}
          >
            <span className="truncate">{url}</span>
            {copied ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-green-500" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5 shrink-0 opacity-60 group-hover:opacity-100" aria-hidden="true" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[32rem] break-all font-mono text-xs">
          {failed ? 'Copy blocked by the browser — select the URL and copy manually.' : url}
        </TooltipContent>
      </Tooltip>
      {/* Announced to screen readers; the icon swap alone is a purely visual signal. */}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? 'Relay URL copied to clipboard' : failed ? 'Copy failed' : ''}
      </span>
    </TooltipProvider>
  );
}
