"use client";

import { useEffect, useState } from "react";

/**
 * A headline figure counts up from zero the first time it is on screen, and never again: the
 * server renders the final value (so the number is right before any script runs) and the client
 * replays the climb once on mount. Reduced motion shows the final value only.
 */
export function CountUp({ value, duration = 700, className }: { value: number; duration?: number; className?: string }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    // mount only: the effect has no dependencies, and its cleanup cancels a run that is unmounted
    // (React's development double-invoke included), so a re-render never replays the climb
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || value === 0) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    setShown(0);
    raf = requestAnimationFrame(tick);
    // a background tab throttles animation frames; the figure must still land on its value
    const settle = setTimeout(() => setShown(value), duration + 100);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <span className={className} data-count-up={value}>
      {shown.toLocaleString("en-US")}
    </span>
  );
}
