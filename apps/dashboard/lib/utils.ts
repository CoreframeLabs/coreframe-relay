import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class names, letting later classes win over earlier conflicting ones.
 * Required by every shadcn/ui component. Added in [RELAY-1].
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
