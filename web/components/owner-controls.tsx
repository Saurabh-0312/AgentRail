"use client";

import { useState } from "react";

import { Addr } from "@/components/addr";
import { ChainBadge } from "@/components/chain-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CHAINS } from "@/lib/chains";
import { CREATE_DEFAULTS, type OwnerGate } from "@/lib/owner";
import { ASSETS, CHAIN_ASSET, tryFormatUnits } from "@/lib/units";

export type EvmChain = "hedera" | "base";

export interface MandateSummary {
  id: string;
  active: boolean;
  agent: string | null;
}

export interface CreateForm {
  chain: EvmChain;
  agent: string;
  ensName: string;
  destination: string;
  perTx: string;
  total: string;
  days: number;
}

export interface ActionResult {
  kind: "revoke" | "create";
  chain: EvmChain;
  step: string;
  hash?: string;
  error?: string;
  done?: boolean;
}

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
  onCreate,
  busy,
  results,
  connect,
}: {
  gate: OwnerGate;
  owner: string;
  mandates: Partial<Record<EvmChain, MandateSummary>>;
  defaultEnsName: string;
  onRevoke?: (chain: EvmChain, mandateId: string) => void;
  onCreate?: (form: CreateForm) => void;
  busy?: boolean;
  results?: ActionResult[];
  connect?: React.ReactNode;
}) {
  const [confirm, setConfirm] = useState<EvmChain | null>(null);
  const [form, setForm] = useState<CreateForm>({ chain: "base", agent: "", ensName: defaultEnsName, destination: "", perTx: CREATE_DEFAULTS.perTx, total: CREATE_DEFAULTS.total, days: CREATE_DEFAULTS.days });
  const set = <K extends keyof CreateForm>(k: K, v: CreateForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const disabled = !gate.enabled || !!busy;
  const asset = ASSETS[CHAIN_ASSET[form.chain] ?? "usdc-base"];
  /** The live conversion under each cap field: what the base units the contract stores mean. */
  const Conversion = ({ units }: { units: string }) => {
    const f = tryFormatUnits(units, asset.decimals, asset.symbol);
    return (
      <span className="mt-1 block text-xs tnum" data-testid="conversion">
        {f ? (
          <>
            = <span className="font-medium text-ink">{f.human}</span> <span className="text-muted">({f.raw} base units, {asset.decimals} decimals)</span>
          </>
        ) : (
          <span className="text-blocked">whole base units only</span>
        )}
      </span>
    );
  };

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
          <CardDescription>
            Kills the mandate on that chain instantly and independently: <code>EvmMandate.revokeMandate</code>. Every chain enforces on its own; there is no bridge and no propagation delay. The Solana mandate is revoked by the owner&apos;s CLI (<code>revoke_mandate</code>), and the SPL delegation is a second, independent kill switch.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(["hedera", "base"] as EvmChain[]).map((chain) => {
            const m = mandates[chain];
            const canRevoke = !disabled && !!m && m.active;
            return (
              <div key={chain} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm">
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
        </CardContent>
      </Card>

      <Card accent="ens">
        <CardHeader>
          <CardTitle>Create agent</CardTitle>
          <CardDescription>
            Issues a mandate on <code>EvmMandate</code> for an agent address: the ENS node it belongs to, an expiry, and one payee with caps. Two signatures, because the contract exposes <code>createMandate</code> and <code>addPermission</code> separately. Instruction lists are a Solana <code>verify</code> feature and are set from the owner&apos;s CLI; on the EVM a permission is a payee plus caps. Registering the ENS subname itself is a separate step on Sepolia.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              onCreate?.(form);
            }}
          >
            <label className="text-xs text-muted">
              chain
              <select className="mt-1 h-10 w-full rounded-md border border-border bg-surface px-3 text-sm" value={form.chain} onChange={(e) => set("chain", e.target.value as EvmChain)} disabled={disabled}>
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
              <Input className="mt-1 mono" value={form.agent} onChange={(e) => set("agent", e.target.value)} placeholder="0x…" disabled={disabled} spellCheck={false} />
            </label>
            <label className="text-xs text-muted">
              allowed payee (0x…)
              <Input className="mt-1 mono" value={form.destination} onChange={(e) => set("destination", e.target.value)} placeholder="0x…" disabled={disabled} spellCheck={false} />
            </label>
            <label className="text-xs text-muted">
              per-transaction cap, in base units of {asset.symbol} ({asset.label})
              <Input className="mt-1 tnum" value={form.perTx} onChange={(e) => set("perTx", e.target.value)} inputMode="numeric" disabled={disabled} />
              <Conversion units={form.perTx} />
            </label>
            <label className="text-xs text-muted">
              lifetime cap, in base units of {asset.symbol}
              <Input className="mt-1 tnum" value={form.total} onChange={(e) => set("total", e.target.value)} inputMode="numeric" disabled={disabled} />
              <Conversion units={form.total} />
            </label>
            <label className="text-xs text-muted">
              expires in (days)
              <Input className="mt-1 tnum" type="number" min={1} max={365} value={form.days} onChange={(e) => set("days", Number(e.target.value))} disabled={disabled} />
            </label>
            <div className="flex items-end">
              <Button type="submit" disabled={disabled || !form.agent || !form.destination} data-testid="create" title={gate.enabled ? undefined : gate.reason}>
                Create mandate
              </Button>
            </div>
          </form>
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
