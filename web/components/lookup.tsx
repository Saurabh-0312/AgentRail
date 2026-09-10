"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { looksLikeName, normalizeName } from "@/lib/ens";

/** One input. Paste a name, see what it may do. Examples so a judge can click rather than type. */
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
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          go(value);
        }}
      >
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="paste an ENS name, e.g. databot.agentrail.eth" aria-label="ENS name" autoFocus spellCheck={false} />
        <Button type="submit" size="lg" disabled={busy}>
          <Search className="size-4" /> {busy ? "resolving…" : "Look up"}
        </Button>
      </form>
      {problem && <p className="text-sm text-blocked">{problem}</p>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">try:</span>
        {examples.map((e) => (
          <Link key={e.name} href={`/agent/${e.name}`} className="rounded-md border border-border bg-surface px-2.5 py-1 hover:bg-muted-soft" title={e.hint}>
            <span className="mono">{e.name}</span> <span className="text-xs text-muted">{e.hint}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
