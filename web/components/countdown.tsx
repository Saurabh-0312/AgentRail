"use client";

import { useEffect, useState } from "react";

import { untilExpiry } from "@/lib/format";

/** "expires in 3 h 12 min", ticking, from a unix expiry. */
export function Countdown({ expiry }: { expiry: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(t);
  }, []);
  const e = untilExpiry(expiry, now);
  return <span className={e.expired ? "text-blocked" : "text-ink"} suppressHydrationWarning>{e.text}</span>;
}
