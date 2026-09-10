import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "AgentRail",
  description: "Instruction-level authorization for AI agents. Paste an agent's ENS name and see what it may do.",
};

const NAV = [
  { href: "/", label: "Lookup" },
  { href: "/agent/databot.agentrail.eth", label: "Agent" },
  { href: "/activity", label: "Activity" },
  { href: "/services", label: "Services" },
  { href: "/attack", label: "Attack" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto max-w-6xl px-4 h-14 flex items-center gap-6">
            <Link href="/" className="font-semibold tracking-tight text-ink">
              AgentRail
            </Link>
            <nav className="flex items-center gap-4 text-sm text-muted">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="hover:text-ink">
                  {n.label}
                </Link>
              ))}
            </nav>
            <a href="https://github.com/Saurabh-0312/AgentRail" className="ml-auto text-sm text-muted hover:text-ink" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-8 flex-1">{children}</main>
        <footer className="border-t border-border">
          <div className="mx-auto max-w-6xl px-4 py-4 text-xs text-muted flex flex-wrap gap-x-6 gap-y-1 items-center">
            <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-ens" /> ENS</span>
            <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-graph" /> The Graph</span>
            <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-hedera" /> Hedera</span>
            <span className="inline-flex items-center gap-1.5"><i className="inline-block size-2.5 rounded-sm bg-solana" /> Solana (AgentRail)</span>
            <span className="ml-auto">Agents go off the rails. AgentRail is the rails.</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
