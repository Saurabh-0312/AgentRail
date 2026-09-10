import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm text-ink placeholder:text-muted hover:border-border-strong focus-visible:border-ens focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ens/40 disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
