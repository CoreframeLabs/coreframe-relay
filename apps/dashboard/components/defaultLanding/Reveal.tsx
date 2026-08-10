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
 */
import { useEffect, useRef, type ReactNode } from 'react';

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

    el.classList.add('relay-reveal-init');

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
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
};

export default Reveal;
