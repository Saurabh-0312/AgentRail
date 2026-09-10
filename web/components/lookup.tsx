"use client";

import { ArrowRight, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { looksLikeName, normalizeName } from "@/lib/ens";

/** One input, the visual focus of the landing page. Paste a name, see what it may do; examples so a judge can click rather than type. */
export function Lookup({ examples }: { examples: { name: string; hint: string }[] }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (raw: string) => {
    const name = normalizeName(raw);
    if (!looksLikeName(name)) {
      setProblem("That is not an ENS name. Try something like databot.agentrail.eth.");
      return;
    }
    setProblem(null);
    setBusy(true);
    router.push(`/agent/${encodeURIComponent(name)}`);
  };

  return (
    <div className="space-y-3">
      <form
        className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-2 shadow-2 sm:flex-row sm:items-center focus-within:border-ens/60 focus-within:ring-2 focus-within:ring-ens/30"
        onSubmit={(e) => {
          e.preventDefault();
          go(value);
        }}
      >
        <label className="flex flex-1 items-center gap-3 px-3">
          <Search className="size-5 shrink-0 text-muted" aria-hidden />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste an ENS name, e.g. databot.agentrail.eth"
            aria-label="ENS name"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            className="h-12 w-full bg-transparent text-base text-ink placeholder:text-muted focus:outline-none sm:text-lg"
          />
        </label>
        <Button type="submit" size="lg" disabled={busy} className="sm:min-w-36">
          {busy ? "resolving…" : "Look up"} {!busy && <ArrowRight className="size-4" aria-hidden />}
        </Button>
      </form>
      {problem && <p className="text-sm text-blocked">{problem}</p>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">try:</span>
        {examples.map((e) => (
          <Link
            key={e.name}
            href={`/agent/${e.name}`}
            className="group inline-flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-3 pr-2 shadow-1 hover:border-border-strong hover:bg-muted-soft hover:shadow-2"
            title={e.hint}
          >
            <span className="mono">{e.name}</span>
            <span className="rounded-full bg-muted-soft px-2 py-0.5 text-[11px] text-muted group-hover:text-ink">{e.hint}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
