import { Figure } from "@/components/amount";
import { GrowBar } from "@/components/motion";
import { cn } from "@/lib/cn";
import { headroom } from "@/lib/format";
import { formatChainAmount } from "@/lib/units";

/**
 * spent / cap as a bar, coloured by headroom (state), with the figures a judge can read in the
 * chain's asset. The bar grows to its value on mount rather than appearing full.
 */
export function SpendBar({ spent, cap, chain }: { spent: string; cap: string; chain: string }) {
  const h = headroom(spent, cap);
  const usedPct = h === null ? 0 : Math.round((1 - h) * 100);
  const tone = h === null ? "bg-muted" : h > 0.5 ? "bg-allowed" : h > 0.2 ? "bg-warn" : "bg-blocked";
  const remaining = h === null ? null : (BigInt(cap) - BigInt(spent)).toString();
  const fSpent = formatChainAmount(chain, spent);
  const fLeft = remaining === null ? null : formatChainAmount(chain, remaining);
  const fCap = formatChainAmount(chain, cap);
  return (
    <div className="tnum" data-spend-bar={usedPct}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-ink">
          <span className="font-medium">{fSpent ? <Figure f={fSpent} secondary="tooltip" /> : spent}</span> spent
        </span>
        <span className="text-muted">
          {h === null ? "no lifetime cap" : (
            <>
              {fLeft ? <Figure f={fLeft} secondary="tooltip" /> : remaining} left of {fCap ? <Figure f={fCap} secondary="tooltip" /> : cap}
            </>
          )}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted-soft ring-1 ring-inset ring-border/60">
        <GrowBar pct={usedPct} className={cn("h-full rounded-full", tone)} />
      </div>
    </div>
  );
}
