import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/** Colour means state or chain, never decoration. */
const badgeVariants = cva("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    variant: {
      neutral: "border-border bg-muted-soft text-ink",
      allowed: "border-allowed/30 bg-allowed-soft text-allowed",
      blocked: "border-blocked/30 bg-blocked-soft text-blocked",
      warn: "border-warn/30 bg-warn-soft text-warn",
      ens: "border-ens/30 bg-ens/10 text-ens",
      graph: "border-graph/30 bg-graph/10 text-graph",
      hedera: "border-hedera/30 bg-hedera/10 text-hedera",
      solana: "border-solana/30 bg-solana/10 text-solana",
    },
  },
  defaultVariants: { variant: "neutral" },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
