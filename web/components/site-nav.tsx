"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";

export const NAV = [
  { href: "/", label: "Lookup", match: (p: string) => p === "/" },
  { href: "/agent/databot.agentrail.eth", label: "Agent", match: (p: string) => p.startsWith("/agent/") },
  { href: "/activity", label: "Activity", match: (p: string) => p.startsWith("/activity") },
  { href: "/services", label: "Services", match: (p: string) => p.startsWith("/services") },
  { href: "/attack", label: "Attack", match: (p: string) => p.startsWith("/attack") },
];

/** The five pages, with the current one marked. */
export function SiteNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="flex items-center gap-1 text-sm" aria-label="primary">
      {NAV.map((n) => {
        const active = n.match(pathname);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={cn("rounded-md px-2.5 py-1.5 hover:bg-muted-soft hover:text-ink", active ? "bg-muted-soft font-medium text-ink" : "text-muted")}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
