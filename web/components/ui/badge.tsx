import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/** Colour means state or chain, never decoration. */
const badgeVariants = cva("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors", {
  variants: {
    variant: {
      neutral: "border-border bg-muted-soft text-ink",
      allowed: "border-allowed/30 bg-allowed-soft text-allowed",
      blocked: "border-blocked/40 bg-blocked-soft text-blocked",
      "blocked-solid": "border-blocked bg-blocked text-ink-inverse shadow-[0_0_12px_var(--glow-blocked)]",
      warn: "border-warn/30 bg-warn-soft text-warn",
      ens: "border-ens/30 bg-ens/10 text-ens",
      graph: "border-graph/30 bg-graph/10 text-graph",
      hedera: "border-hedera/30 bg-hedera/10 text-hedera",
      solana: "border-solana/30 bg-solana/10 text-solana",
      agent: "border-agent/30 bg-agent/10 text-agent",
    },
    size: {
      default: "",
      lg: "px-2.5 py-1 text-sm font-semibold",
    },
  },
  defaultVariants: { variant: "neutral", size: "default" },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}
