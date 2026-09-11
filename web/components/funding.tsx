import { Amount } from "@/components/amount";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { DELEGATION_COPY, fundingStatus, type Funding } from "@/lib/delegation";

/**
 * The owner's standing with the mandate's token: what the contract may pull (the allowance), what
 * the caps still need, and the owner's balance. When the allowance falls short the panel is loud,
 * because a mandate that looks active and cannot pay is the silent failure this exists to surface.
 */
export function FundingPanel({ chain, funding, active, delegateHref = "#delegate", error }: { chain: string; funding?: Funding; active: boolean; delegateHref?: string; error?: string }) {
  if (error && !funding) {
    return (
      <p className="text-xs text-warn" data-funding="unknown">
        allowance not read: {error}
      </p>
    );
  }
  if (!funding) return null;
  const status = fundingStatus(funding);
  const asset = { chain } as const;
  const short = active && (status.state === "unfunded" || status.state === "under-funded");
  return (
    <div className={cn("rounded-lg border p-3 text-sm space-y-2", short ? "border-blocked/60 bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_60%)]" : "border-border bg-surface-sunken/70")} data-funding={status.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">delegated funds</span>
        {status.state === "funded" && <Badge variant="allowed">funded</Badge>}
        {status.state === "nothing-to-fund" && <Badge variant="neutral">caps fully spent</Badge>}
        {status.state === "under-funded" && <Badge variant="blocked-solid" className="font-semibold">under-funded</Badge>}
        {status.state === "unfunded" && <Badge variant="blocked-solid" className="font-semibold">not funded</Badge>}
        {status.balanceShort && <Badge variant="warn">owner balance below the caps</Badge>}
      </div>
      <div className="grid grid-cols-3 gap-3 text-xs tnum">
        <div>
          <div className="text-muted">allowance to EvmMandate</div>
          <div className="font-medium text-sm"><Amount chain={asset.chain} units={funding.allowance} secondary="below" /></div>
        </div>
        <div>
          <div className="text-muted">the caps still permit</div>
          <div className="font-medium text-sm">{funding.required === null ? "unlimited" : <Amount chain={asset.chain} units={funding.required} secondary="below" />}</div>
        </div>
        <div>
          <div className="text-muted">owner balance</div>
          <div className="font-medium text-sm"><Amount chain={asset.chain} units={funding.balance} secondary="below" /></div>
        </div>
      </div>
      {short && (
        <div className="space-y-1.5" data-testid="funding-warning">
          <p className="font-semibold text-blocked">
            {status.state === "unfunded" ? "Not funded" : "Under-funded"} — this mandate cannot pull funds from the owner&apos;s wallet.
            {status.state === "under-funded" && (<> It is short by <Amount chain={asset.chain} units={status.shortfall} secondary="tooltip" />.</>)}
          </p>
          <p className="text-xs text-muted">{DELEGATION_COPY}</p>
          <a href={delegateHref} className="inline-flex h-8 items-center rounded-md bg-blocked px-3 text-xs font-semibold text-ink-inverse shadow-1 hover:bg-blocked/90 hover:shadow-2">
            Delegate funds
          </a>
        </div>
      )}
      {!short && status.state === "funded" && <p className="text-xs text-muted">{DELEGATION_COPY}</p>}
    </div>
  );
}
