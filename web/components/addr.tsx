"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { truncate } from "@/lib/format";

/** An address, signature or id: monospace, middle-truncated, copied on click, linked when there is a place to verify it. */
export function Addr({ value, href, head = 6, tail = 4, full = false, className }: { value: string; href?: string; head?: number; tail?: number; full?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const shown = full ? value : truncate(value, head, tail);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable: nothing to do */
    }
  };
  return (
    <span className={cn("inline-flex items-center gap-1 max-w-full", className)}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" title={value} className="mono underline decoration-border underline-offset-2 hover:decoration-ink break-all">
          {shown}
        </a>
      ) : (
        <span className="mono break-all" title={value}>
          {shown}
        </span>
      )}
      <button type="button" onClick={copy} aria-label="copy" title={copied ? "copied" : "copy"} className="shrink-0 text-muted hover:text-ink">
        {copied ? <Check className="size-3.5 text-allowed" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}
