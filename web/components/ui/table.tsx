import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

/**
 * Tables for anything with more than three rows. Wide content scrolls inside its own box below the
 * laptop breakpoint; from `lg` up the box is open so a sticky header can pin to the page.
 */
export function Table({ className, dense = false, stickyHeader = false, ...props }: HTMLAttributes<HTMLTableElement> & { dense?: boolean; stickyHeader?: boolean }) {
  return (
    <div className={cn("scroll-x rounded-xl border border-border bg-surface shadow-1", stickyHeader && "lg:overflow-visible")}>
      <table className={cn("w-full text-sm", dense && "text-[13px]", className)} data-dense={dense || undefined} data-sticky={stickyHeader || undefined} {...props} />
    </div>
  );
}

export function THead({ className, sticky = false, ...props }: HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }) {
  return <thead className={cn("bg-surface-sunken text-xs uppercase tracking-wide text-muted", sticky && "lg:sticky lg:top-14 lg:z-10 lg:shadow-1", className)} {...props} />;
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-t border-border transition-colors hover:bg-muted-soft/60", className)} {...props} />;
}

export function TH({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("px-3 py-2 text-left font-medium", className)} {...props} />;
}

export function TD({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-3 py-2 align-top [table[data-dense]_&]:py-1.5", className)} {...props} />;
}
