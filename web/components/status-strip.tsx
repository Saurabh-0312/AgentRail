"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import type { StatusPayload } from "@/lib/status";

/**
 * Four chains, one real dot each, loaded after the page paints so the lookup is instant. Grey while
 * checking, green when the read succeeded, red when it did not; the feed shows "waking" when
 * Render's free tier is asleep rather than pretending it is down or up.
 */
export function StatusStrip() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/status")
      .then((r) => r.json())
      .then((j: StatusPayload) => {
        if (!cancelled) setStatus(j);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const entries = status ? [...status.chains, status.feed] : [
    { key: "sepolia", label: "ENS · Sepolia" },
    { key: "base", label: "Base Sepolia" },
    { key: "hedera", label: "Hedera testnet" },
    { key: "solana", label: "Solana devnet" },
    { key: "feed", label: "x402 feed (Render)" },
  ];

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        {entries.map((e) => {
          const s = status ? (e as StatusPayload["feed"]) : null;
          const sleeping = s && "sleeping" in s && s.sleeping;
          const dot = !status ? "bg-muted animate-pulse" : sleeping ? "bg-warn" : s!.ok ? "bg-allowed" : "bg-blocked";
          const text = !status ? "checking…" : sleeping ? "waking" : s!.ok ? `${s!.latencyMs} ms` : "down";
          return (
            <span key={e.key} className="inline-flex items-center gap-2" title={s ? s.detail : ""}>
              <i className={cn("inline-block size-2.5 rounded-full", dot)} />
              <span className="text-ink">{e.label}</span>
              <span className="text-xs text-muted tnum">{text}</span>
            </span>
          );
        })}
        {status && (
          <span className="ml-auto text-xs text-muted tnum">
            index heads: {status.index.map((i) => `${i.key.replace("index-", "")} ${i.ok ? i.detail.replace("head block ", "#") : "down"}`).join(" · ")}
          </span>
        )}
        {error && <span className="text-xs text-blocked">status unavailable: {error}</span>}
      </div>
    </div>
  );
}
