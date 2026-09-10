import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/** A white surface with a thin border; `accent` adds the chain-coloured top rule of the flow diagram. */
export function Card({ className, accent, ...props }: HTMLAttributes<HTMLDivElement> & { accent?: "ens" | "graph" | "hedera" | "solana" | "allowed" | "blocked" | "warn" | "agent" }) {
  const top = accent ? { ens: "border-t-ens", graph: "border-t-graph", hedera: "border-t-hedera", solana: "border-t-solana", allowed: "border-t-allowed", blocked: "border-t-blocked", warn: "border-t-warn", agent: "border-t-agent" }[accent] : "";
  return <div className={cn("rounded-lg border border-border bg-surface", accent && "border-t-4", top, className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pt-4 pb-2", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-sm font-semibold tracking-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}
