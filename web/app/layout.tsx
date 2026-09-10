import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { SiteNav } from "@/components/site-nav";
import { THEME_INIT_SCRIPT, ThemeToggle } from "@/components/theme-toggle";
import { WalletProvider } from "@/components/wallet/provider";

import "./globals.css";

export const metadata: Metadata = {
  title: "AgentRail",
  description: "Instruction-level authorization for AI agents. Paste an agent's ENS name and see what it may do.",
};

const LEGEND: { token: string; label: string }[] = [
  { token: "bg-ens", label: "ENS · the name" },
  { token: "bg-graph", label: "The Graph · the index" },
  { token: "bg-hedera", label: "Hedera · a gate" },
  { token: "bg-solana", label: "Solana · the gate" },
  { token: "bg-blocked", label: "blocked" },
  { token: "bg-allowed", label: "allowed" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // the theme attribute is set before paint by the inlined script; dark is the server default
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen flex flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-surface-2/85 shadow-1 backdrop-blur">
          <div className="mx-auto max-w-6xl px-4 h-14 flex items-center gap-4">
            <Link href="/" className="inline-flex items-center gap-2 font-semibold tracking-tight text-ink">
              <span className="inline-flex size-6 items-center justify-center rounded-md bg-solana text-ink-inverse text-xs font-bold" aria-hidden>
                A
              </span>
              AgentRail
            </Link>
            <SiteNav />
            <div className="ml-auto flex items-center gap-2">
              <a href="https://github.com/Saurabh-0312/AgentRail" className="rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-muted-soft hover:text-ink" target="_blank" rel="noreferrer">
                GitHub
              </a>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-8 flex-1">
          <WalletProvider>{children}</WalletProvider>
        </main>
        <footer className="border-t border-border bg-surface/60">
          <div className="mx-auto max-w-6xl px-4 py-4 text-xs text-muted flex flex-wrap gap-x-5 gap-y-2 items-center">
            {LEGEND.map((l) => (
              <span key={l.label} className="inline-flex items-center gap-1.5">
                <i className={`inline-block size-2.5 rounded-sm ${l.token}`} /> {l.label}
              </span>
            ))}
            <span className="ml-auto">Agents go off the rails. AgentRail is the rails.</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
