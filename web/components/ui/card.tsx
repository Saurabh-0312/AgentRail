import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export type Accent = "ens" | "graph" | "hedera" | "solana" | "allowed" | "blocked" | "warn" | "agent";

const LEFT: Record<Accent, string> = {
  ens: "border-l-ens",
  graph: "border-l-graph",
  hedera: "border-l-hedera",
  solana: "border-l-solana",
  allowed: "border-l-allowed",
  blocked: "border-l-blocked",
  warn: "border-l-warn",
  agent: "border-l-agent",
};

/**
 * A raised surface: one elevation level above the page wash, two for things that float (menus,
 * the header). `accent` is a coloured left rule, the only way a chain or a state colours a card;
 * never the whole card.
 */
export function Card({ className, accent, elevation = 1, interactive = false, ...props }: HTMLAttributes<HTMLDivElement> & { accent?: Accent; elevation?: 1 | 2; interactive?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-surface shadow-1",
        elevation === 2 && "bg-surface-2 shadow-2",
        accent && "border-l-4",
        accent && LEFT[accent],
        interactive && "transition-[box-shadow,border-color,transform] duration-200 hover:border-border-strong hover:shadow-2",
        className,
      )}
      {...props}
    />
  );
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
