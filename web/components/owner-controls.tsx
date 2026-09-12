"use client";

import { type ReactNode, useEffect, useState } from "react";

import { Addr } from "@/components/addr";
import { Amount } from "@/components/amount";
import { ChainBadge } from "@/components/chain-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CHAINS } from "@/lib/chains";
import { cn } from "@/lib/cn";
import { DELEGATION_COPY, STEPS, fundingStatus, stepSatisfied, suggestedAllowance, type Funding, type StepProgress } from "@/lib/delegation";
import { CREATE_DEFAULTS, type OwnerGate } from "@/lib/owner";
import { isAddress, tokenFor } from "@/lib/tokens";
import { ASSETS, CHAIN_ASSET, tryFormatUnits } from "@/lib/units";

export type EvmChain = "hedera" | "base";

export interface MandateSummary {
  id: string;
  active: boolean;
  agent: string | null;
  /** The owner's allowance and balance in the chain's token, read on the server. */
  funding?: Funding;
}

export interface CreateForm {
  chain: EvmChain;
  agent: string;
  ensName: string;
  destination: string;
  perTx: string;
  total: string;
  days: number;
  /** Step 3: the ERC-20 the mandate will pull, defaulted from the chain, and how much to approve. */
  token: string;
  approveAmount: string;
}

export interface ActionResult {
  kind: "revoke" | "create" | "delegate";
  chain: EvmChain;
  step: string;
  hash?: string;
  error?: string;
  done?: boolean;
}

export type CreateProgress = Partial<Record<1 | 2 | 3, StepProgress>>;

const defaultToken = (chain: EvmChain) => tokenFor(chain)?.address ?? "";

/**
 * The controls themselves, with no wallet inside: the gate decides whether they are enabled, the
 * handlers do the work. Presentational, so it renders to static markup in tests. A visitor sees
 * every control and the sentence explaining why it is disabled.
 */
export function OwnerControls({
  gate,
  owner,
  mandates,
  defaultEnsName,
  onRevoke,
  solanaRevoke,
  onCreate,
  onDelegate,
  busy,
  results,
  progress,
  connect,
}: {
  gate: OwnerGate;
  owner: string;
  mandates: Partial<Record<EvmChain, MandateSummary>>;
  defaultEnsName: string;
  onRevoke?: (chain: EvmChain, mandateId: string) => void;
  /** The Solana revoke row, rendered in the same card; it signs with the Solana wallet, not wagmi. */
  solanaRevoke?: ReactNode;
  onCreate?: (form: CreateForm) => void;
  onDelegate?: (chain: EvmChain, token: string, amount: string) => void;
  busy?: boolean;
  results?: ActionResult[];
  /** Live status of the three create steps. */
  progress?: CreateProgress;
  connect?: React.ReactNode;
}) {
  const [confirm, setConfirm] = useState<EvmChain | null>(null);
  const [form, setForm] = useState<CreateForm>({ chain: "base", agent: "", ensName: defaultEnsName, destination: "", perTx: CREATE_DEFAULTS.perTx, total: CREATE_DEFAULTS.total, days: CREATE_DEFAULTS.days, token: defaultToken("base"), approveAmount: CREATE_DEFAULTS.total });
  const [approveTouched, setApproveTouched] = useState(false);
  const set = <K extends keyof CreateForm>(k: K, v: CreateForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const disabled = !gate.enabled || !!busy;
  const asset = ASSETS[CHAIN_ASSET[form.chain] ?? "usdc-base"];
  /** The live conversion under each cap field: what the base units the contract stores mean. */
  const Conversion = ({ units, decimals = asset.decimals, symbol = asset.symbol }: { units: string; decimals?: number; symbol?: string }) => {
    const f = tryFormatUnits(units, decimals, symbol);
    return (
      <span className="mt-1 block text-xs tnum" data-testid="conversion">
        {f ? (
          <>
            = <span className="font-medium text-ink">{f.human}</span> <span className="text-muted">({f.raw} base units, {decimals} decimals)</span>
          </>
        ) : (
          <span className="text-blocked">whole base units only</span>
        )}
      </span>
    );
  };
  const setChain = (chain: EvmChain) => setForm((f) => ({ ...f, chain, token: defaultToken(chain) }));
  const setTotal = (total: string) => setForm((f) => ({ ...f, total, approveAmount: approveTouched ? f.approveAmount : total }));
  const tokenOk = isAddress(form.token);
  const canCreate = !disabled && !!form.agent && !!form.destination && tokenOk && /^\d+$/.test(form.approveAmount.trim());

  return (
    <div className="space-y-4" data-gate={gate.state}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant={gate.enabled ? "allowed" : "neutral"}>{gate.enabled ? "owner connected" : "read only"}</Badge>
        <span className="text-muted" data-testid="gate-reason">{gate.reason}</span>
        <span className="ml-auto">{connect}</span>
      </div>

      <Card accent="blocked">
        <CardHeader>
          <CardTitle>Revoke</CardTitle>
          <CardDescription>Kills the mandate on this chain instantly: <code>revokeMandate</code>.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(["hedera", "base"] as EvmChain[]).map((chain) => {
            const m = mandates[chain];
            const canRevoke = !disabled && !!m && m.active;
            return (
              <div key={chain} className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-sunken/70 p-3 text-sm">
                <ChainBadge chain={chain} />
                {m ? (
                  <>
                    <span className="text-muted">mandate</span> <Addr value={m.id} href={CHAINS[chain].address("0x68822ce9109D9d71e99b07703cF6c851D0229AA9")} />
                    <Badge variant={m.active ? "allowed" : "blocked"}>{m.active ? "active" : "revoked"}</Badge>
                  </>
                ) : (
                  <span className="text-muted">no mandate read for this chain</span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  {confirm === chain ? (
                    <>
                      <span className="text-xs text-blocked">This cannot be undone here. Revoke on {CHAINS[chain].short}?</span>
                      <Button variant="danger" size="sm" disabled={!canRevoke} onClick={() => { setConfirm(null); if (m) onRevoke?.(chain, m.id); }} data-testid={`revoke-${chain}-confirm`}>
                        yes, revoke
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setConfirm(null)}>cancel</Button>
                    </>
                  ) : (
                    <Button variant="danger" size="sm" disabled={!canRevoke} onClick={() => setConfirm(chain)} data-testid={`revoke-${chain}`} title={gate.enabled ? undefined : gate.reason}>
                      REVOKE
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
          {solanaRevoke}
        </CardContent>
      </Card>

      <Card accent="hedera" id="delegate" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Delegate funds</CardTitle>
          <CardDescription>Approve what the mandate may pull. Tokens stay in your wallet.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(["hedera", "base"] as EvmChain[]).map((chain) => (
            <DelegateRow key={chain} chain={chain} m={mandates[chain]} disabled={disabled} gate={gate} onDelegate={onDelegate} />
          ))}
        </CardContent>
      </Card>

      <Card accent="ens">
        <CardHeader>
          <CardTitle>Create agent</CardTitle>
          <CardDescription>Mandate, permission, then approval: three signatures.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              onCreate?.(form);
            }}
          >
            <label className="text-xs text-muted">
              chain
              <select className="mt-1 h-10 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm" value={form.chain} onChange={(e) => setChain(e.target.value as EvmChain)} disabled={disabled}>
                <option value="base">Base Sepolia</option>
                <option value="hedera">Hedera testnet</option>
              </select>
            </label>
            <label className="text-xs text-muted">
              ENS name (its node is written into the mandate)
              <Input className="mt-1" value={form.ensName} onChange={(e) => set("ensName", e.target.value)} disabled={disabled} spellCheck={false} />
            </label>
            <label className="text-xs text-muted">
              agent address (0x…)
              <Input className="mt-1 mono" value={form.agent} onChange={(e) => set("agent", e.target.value)} placeholder="0x…" disabled={disabled} spellCheck={false} data-testid="agent" />
            </label>
            <label className="text-xs text-muted">
              allowed payee (0x…)
              <Input className="mt-1 mono" value={form.destination} onChange={(e) => set("destination", e.target.value)} placeholder="0x…" disabled={disabled} spellCheck={false} data-testid="destination" />
            </label>
            <label className="text-xs text-muted">
              per-transaction cap, in base units of {asset.symbol} ({asset.label})
              <Input className="mt-1 tnum" value={form.perTx} onChange={(e) => set("perTx", e.target.value)} inputMode="numeric" disabled={disabled} data-testid="per-tx" />
              <Conversion units={form.perTx} />
            </label>
            <label className="text-xs text-muted">
              lifetime cap, in base units of {asset.symbol}
              <Input className="mt-1 tnum" value={form.total} onChange={(e) => setTotal(e.target.value)} inputMode="numeric" disabled={disabled} data-testid="total" />
              <Conversion units={form.total} />
            </label>
            <label className="text-xs text-muted">
              expires in (days)
              <Input className="mt-1 tnum" type="number" min={1} max={365} value={form.days} onChange={(e) => set("days", Number(e.target.value))} disabled={disabled} data-testid="days" />
            </label>
            <div className="sm:col-span-2 rounded-lg border border-hedera/40 bg-hedera/5 p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="hedera">step 3 of 3</Badge>
                <span className="font-medium">Delegate funds</span>
                <span className="text-xs text-muted">{DELEGATION_COPY}</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-muted">
                  token to delegate (defaults to {asset.label}; paste another ERC-20 to override)
                  <Input className={cn("mt-1 mono", !tokenOk && "border-blocked")} value={form.token} onChange={(e) => set("token", e.target.value)} disabled={disabled} spellCheck={false} data-testid="token" />
                  {!tokenOk && <span className="mt-1 block text-xs text-blocked">not an address</span>}
                </label>
                <label className="text-xs text-muted">
                  amount to approve, in base units (pre-filled from the lifetime cap; you may raise it)
                  <Input
                    className="mt-1 tnum"
                    value={form.approveAmount}
                    onChange={(e) => {
                      setApproveTouched(true);
                      set("approveAmount", e.target.value);
                    }}
                    inputMode="numeric"
                    disabled={disabled}
                    data-testid="approve-amount"
                  />
                  <Conversion units={form.approveAmount} />
                </label>
              </div>
            </div>
            <div className="sm:col-span-2 flex items-end">
              <Button type="submit" disabled={!canCreate} data-testid="create" title={gate.enabled ? undefined : gate.reason}>
                Create mandate · 3 signatures
              </Button>
            </div>
          </form>

          <ol className="grid gap-2 sm:grid-cols-3" data-testid="create-steps">
            {STEPS.map((s) => {
              const p = progress?.[s.n] ?? { state: "idle" as const };
              return (
                <li key={s.n} className={cn("rounded-lg border p-3 text-sm", p.state === "confirmed" || p.state === "satisfied" ? "border-allowed/50 bg-allowed-soft" : p.state === "failed" ? "border-blocked/60 bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_60%)]" : p.state === "pending" ? "border-warn/50 bg-warn-soft" : "border-border bg-surface-sunken/70")} data-testid={`step-${s.n}`} data-state={p.state}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted">{s.n} of 3</span>
                    <span className="font-medium">{s.title}</span>
                    <StepBadge state={p.state} />
                  </div>
                  {p.note && <div className="mt-1 text-xs text-muted">{p.note}</div>}
                  {p.hash && (
                    <div className="mt-1 text-xs">
                      tx <Addr value={p.hash} href={CHAINS[form.chain].tx(p.hash)} head={10} tail={6} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      {results && results.length > 0 && (
        <Card>
          <CardContent className="pt-4 space-y-1 text-sm">
            {results.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <ChainBadge chain={r.chain} />
                <span className="mono text-xs">{r.kind}</span>
                <span>{r.step}</span>
                {r.hash && <Addr value={r.hash} href={CHAINS[r.chain].tx(r.hash)} head={10} tail={6} />}
                {r.error && <span className="text-blocked text-xs">{r.error}</span>}
                {r.done && <Badge variant="allowed">confirmed</Badge>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StepBadge({ state }: { state: StepProgress["state"] }) {
  switch (state) {
    case "pending":
      return <Badge variant="warn">pending…</Badge>;
    case "confirmed":
      return <Badge variant="allowed">confirmed</Badge>;
    case "satisfied":
      return <Badge variant="allowed">already covered · skipped</Badge>;
    case "failed":
      return <Badge variant="blocked">failed</Badge>;
    default:
      return <Badge variant="neutral">not started</Badge>;
  }
}

/** One existing mandate's funding, with the approve control. The amount pre-fills to what the caps still permit. */
function DelegateRow({ chain, m, disabled, gate, onDelegate }: { chain: EvmChain; m?: MandateSummary; disabled: boolean; gate: OwnerGate; onDelegate?: (chain: EvmChain, token: string, amount: string) => void }) {
  const token = tokenFor(chain);
  const [tokenAddr, setTokenAddr] = useState(token?.address ?? "");
  const [amount, setAmount] = useState(m?.funding ? suggestedAllowance(m.funding) : "");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched && m?.funding) setAmount(suggestedAllowance(m.funding));
  }, [m?.funding, touched]);
  const f = m?.funding;
  const status = f ? fundingStatus(f) : null;
  const covered = f ? stepSatisfied(f.allowance, amount) : false;
  const canApprove = !disabled && !!m && m.active && isAddress(tokenAddr) && /^\d+$/.test(amount.trim()) && BigInt(amount.trim() || "0") > 0n;
  return (
    <div className={cn("rounded-lg border p-3 text-sm space-y-2", status && (status.state === "unfunded" || status.state === "under-funded") && m?.active ? "border-blocked/60 bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_60%)]" : "border-border bg-surface-sunken/70")} data-testid={`delegate-${chain}-row`} data-funding={status?.state ?? "none"}>
      <div className="flex flex-wrap items-center gap-2">
        <ChainBadge chain={chain} />
        {!m && <span className="text-muted">no mandate read for this chain</span>}
        {m && !m.active && <Badge variant="blocked">revoked</Badge>}
        {f && status && (
          <>
            <span className="text-muted">allowance</span> <Amount chain={chain} units={f.allowance} />
            <span className="text-muted">· caps still permit</span> {f.required === null ? <span>unlimited</span> : <Amount chain={chain} units={f.required} />}
            <span className="text-muted">· owner balance</span> <Amount chain={chain} units={f.balance} secondary="tooltip" />
            <span data-testid={`delegate-${chain}-status`}>
              {status.state === "funded" && <Badge variant="allowed">funded</Badge>}
              {status.state === "nothing-to-fund" && <Badge variant="neutral">caps fully spent</Badge>}
              {status.state === "under-funded" && <Badge variant="blocked-solid" className="font-semibold">under-funded</Badge>}
              {status.state === "unfunded" && <Badge variant="blocked-solid" className="font-semibold">not funded</Badge>}
            </span>
          </>
        )}
        {m && !f && <span className="text-xs text-muted">allowance not read</span>}
      </div>
      {m && (
        <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr_auto] sm:items-end">
          <label className="text-xs text-muted">
            token ({token?.asset.label ?? "ERC-20"})
            <Input className="mt-1 mono" value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)} disabled={disabled} spellCheck={false} data-testid={`delegate-${chain}-token`} />
          </label>
          <label className="text-xs text-muted">
            allowance to set, in base units
            <Input
              className="mt-1 tnum"
              value={amount}
              onChange={(e) => {
                setTouched(true);
                setAmount(e.target.value);
              }}
              inputMode="numeric"
              disabled={disabled}
              data-testid={`delegate-${chain}-amount`}
            />
            <span className="mt-1 block text-xs tnum">
              {tryFormatUnits(amount, token?.asset.decimals ?? 6, token?.asset.symbol ?? "") ? (
                <>
                  = <span className="font-medium text-ink">{tryFormatUnits(amount, token?.asset.decimals ?? 6, token?.asset.symbol ?? "")!.human}</span>
                  {covered && <span className="text-allowed"> · the current allowance already covers this</span>}
                </>
              ) : (
                <span className="text-muted">whole base units</span>
              )}
            </span>
          </label>
          <Button variant={covered ? "outline" : "default"} disabled={!canApprove} onClick={() => onDelegate?.(chain, tokenAddr.trim(), amount.trim())} data-testid={`delegate-${chain}`} title={gate.enabled ? undefined : gate.reason}>
            {covered ? "Re-approve anyway" : "Delegate funds"}
          </Button>
        </div>
      )}
    </div>
  );
}
