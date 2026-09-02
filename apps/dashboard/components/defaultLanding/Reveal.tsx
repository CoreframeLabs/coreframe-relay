/**
 * [RELAY-64 v2] Contract motion #2 — section reveal.
 *
 * IntersectionObserver adding one class, once: `opacity` + `translate-y(8px)`,
 * ≤300 ms ease-out, played a single time. The INITIAL STATE RENDERS FULLY
 * VISIBLE (contract §4): the pre-reveal transform is applied ONLY after JS has
 * confirmed the target can be observed, so a client with JS disabled, a failed
 * observer or `prefers-reduced-motion: reduce` sees fully rendered content —
 * motion never gates content. The reduced-motion kill for the class-driven
 * transition lives in `globals.css` next to the wires.
 *
 * [design-overhaul 2026-08] This file's observer logic was never actually mounted
 * anywhere — `GapSection.tsx`, `ProofSection.tsx` and `FoundingAccessSection.tsx` all
 * apply the bare `relay-reveal` className directly to their own elements rather than
 * wrapping them in the `<Reveal>` component below, so nothing ever added
 * `relay-reveal-init`/`relay-is-revealed`, and `globals.css` had no rule for either class
 * — the whole mechanism was dead code and every one of those sections rendered fully
 * static. Rather than rewrite four call sites to adopt a ref-based wrapper (a bigger
 * diff for the same visual result), `RevealObserverMount` below generalises the same
 * IntersectionObserver logic to scan for every `.relay-reveal` element in the document
 * and wire each one up individually — mounted ONCE, from `pages/index.tsx`. The
 * `<Reveal>` component is kept for any future single-element use that wants a ref
 * instead of a className scan.
 */
import { useEffect, useRef, type ReactNode } from 'react';

/** Wires one already-mounted `.relay-reveal` element into the shared observer. */
function observeReveal(el: Element, observer: IntersectionObserver) {
  el.classList.add('relay-reveal-init');
  observer.observe(el);
}

const Reveal = ({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (reduce?.matches) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('relay-is-revealed');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 }
    );
    observeReveal(el, observer);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
};

export default Reveal;

/**
 * Mounted once per page (see `pages/index.tsx`). Scans for every element already
 * carrying the plain `relay-reveal` className — the pattern every landing section
 * actually uses — and wires each into the same single IntersectionObserver instance,
 * so the page pays for one observer rather than one per section.
 *
 * Renders nothing; this is a side-effect-only mount, same contract as `<Reveal>`:
 * `prefers-reduced-motion: reduce` or a missing `IntersectionObserver` means every
 * matched element is simply left in its fully-visible default state.
 */
export const RevealObserverMount = () => {
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (reduce?.matches) return;

    const targets = document.querySelectorAll('.relay-reveal');
    if (targets.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('relay-is-revealed');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 }
    );

    targets.forEach((el) => observeReveal(el, observer));
    return () => observer.disconnect();
  }, []);

  return null;
};
