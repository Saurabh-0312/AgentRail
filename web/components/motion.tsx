import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Motion with meaning, in CSS: a short fade-and-rise when a section first appears, staggered by
 * its position, and a bar that grows to its value. Keyframes run on first paint, before any script
 * loads, so content is never hidden behind hydration; and `prefers-reduced-motion` switches every
 * animation off in globals.css.
 */
const STAGGER_MS = 30;

export function Reveal({ index = 0, children, className, style }: { index?: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={cn("reveal", className)} style={{ animationDelay: `${index * STAGGER_MS}ms`, ...style }} data-reveal={index}>
      {children}
    </div>
  );
}

/** A list of sections, each rising a beat after the one before it. */
export function Stagger({ children, className, start = 0 }: { children: ReactNode[]; className?: string; start?: number }) {
  return (
    <div className={className}>
      {children.map((c, i) => (
        <Reveal key={i} index={start + i}>
          {c}
        </Reveal>
      ))}
    </div>
  );
}

/** A bar that fills to its value on mount instead of appearing full. */
export function GrowBar({ pct, className }: { pct: number; className?: string }) {
  const width = `${Math.max(0, Math.min(100, pct))}%`;
  return <div className={cn("grow-bar", className)} style={{ width }} data-pct={pct} />;
}
