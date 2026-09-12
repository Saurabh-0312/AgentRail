"use client";

import * as anchor from "@coral-xyz/anchor";
import idl from "@agentrail/sdk/src/solana/agentrail.idl.json";
import { catalogueProgram, describeDiscriminator, notPermitted } from "@agentrail/sdk/src/solana/catalogue.ts";
import { createApproveInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Addr } from "@/components/addr";
import { Amount } from "@/components/amount";
import { SolanaConnectButton } from "@/components/solana-connect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CHAINS } from "@/lib/chains";
import { cn } from "@/lib/cn";
import { DELEGATION_COPY, fundingStatus, stepSatisfied, type Funding, type StepProgress } from "@/lib/delegation";
import { AGENTRAIL_PROGRAM, MAX_DISCRIMINATORS, MAX_PERMISSIONS, PROGRAM_CHOICES, defaultDraft, derivePda, ensNodeBytes, isPubkey, paymentPermission, permissionDiscriminators, programPermission, solanaErrorText, toAddPermissionArgs, totalLifetime, validateDraft, type PermissionDraft, type SolanaCreateDraft } from "@/lib/solana-form";
import { SPL_TOKEN_PROGRAM } from "@/lib/spl";
import { tryFormatUnits } from "@/lib/units";

export interface ExistingSolanaMandate {
  pda: string;
  active: boolean;
  funding?: Funding;
}

interface ReadPermission {
  key: string;
  perTx: string;
  total: string;
  spent: string;
  instructions: string[];
  width: number;
}

const USDC = { decimals: 6, symbol: "USDC" };

/** The same decode as the SDK's `readMandate`: the used permissions, discriminators as left-aligned hex. */
async function readMandate(prog: anchor.Program, pda: PublicKey): Promise<{ pda: string; permissions: ReadPermission[]; expiry: number } | null> {
  const accounts = prog.account as unknown as Record<string, { fetchNullable: (k: PublicKey) => Promise<Record<string, unknown> | null> }>;
  const m = await accounts.mandateAccount.fetchNullable(pda);
  if (!m) return null;
  const len = Number(m.permissionsLen);
  const perms = (m.permissions as Record<string, unknown>[]).slice(0, len).map((p) => {
    const dlen = Number(p.discriminatorsLen);
    return {
      key: new PublicKey(p.programId as number[]).toBase58(),
      perTx: String(p.perTxLimit),
      total: String(p.spendLimit),
      spent: String(p.spendTotal),
      instructions: (p.discriminators as number[][]).slice(0, dlen).map((d) => `0x${d.map((b) => b.toString(16).padStart(2, "0")).join("")}`),
      width: Number(p.discriminatorSize),
    };
  });
  return { pda: pda.toBase58(), expiry: Number(m.expiry), permissions: perms };
}

function Conversion({ units }: { units: string }) {
  const f = tryFormatUnits(units, USDC.decimals, USDC.symbol);
  return <span className="mt-1 block text-xs tnum">{f ? (<>= <span className="font-medium text-ink">{f.human}</span> <span className="text-muted">({f.raw} base units)</span></>) : <span className="text-blocked">whole base units only</span>}</span>;
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
      return <Badge variant="blocked-solid">failed</Badge>;
    default:
      return <Badge variant="neutral">not started</Badge>;
  }
}

/** Owner gate on Solana: the connected wallet must be the owner the page belongs to. */
export function solanaOwnerGate(connected: string | null | undefined, owner: string): { enabled: boolean; state: "disconnected" | "wrong-account" | "owner"; reason: string } {
  const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  if (!connected) return { enabled: false, state: "disconnected", reason: `Needs the owner's Solana wallet (${short(owner)}).` };
  if (connected !== owner) return { enabled: false, state: "wrong-account", reason: `Connected as ${short(connected)}, which is not the owner ${short(owner)}. Only the owner's key can issue a mandate for this name.` };
  return { enabled: true, state: "owner", reason: `Connected as the owner ${short(owner)}.` };
}

/**
 * The Solana create form: its own type, fields and validation (Rule 2), an instruction picker
 * per program (Rule 1), signed by the owner's Solana wallet (Rule 3), and the SPL delegation as
 * step 3 (Rule 4). Three kinds of transaction, shown as steps with live status.
 */
export function SolanaCreate({ owner, defaultEnsName, mint, existing }: { owner: string; defaultEnsName: string; mint: string; existing?: ExistingSolanaMandate }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const anchorWallet = useAnchorWallet();
  const connected = publicKey?.toBase58() ?? null;
  const gate = solanaOwnerGate(connected, owner);
  const [draft, setDraft] = useState<SolanaCreateDraft>(() => defaultDraft(defaultEnsName));
  const [approveTouched, setApproveTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Record<string, StepProgress>>({});
  const [result, setResult] = useState<{ pda: string; permissions: ReadPermission[]; expiry: number } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const disabled = !gate.enabled || busy;
  const validation = validateDraft(draft);
  const pda = useMemo(() => (isPubkey(draft.agent) ? derivePda(owner, draft.agent.trim()) : null), [owner, draft.agent]);

  useEffect(() => {
    if (!approveTouched) setDraft((d) => ({ ...d, approveAmount: totalLifetime(d.permissions) }));
  }, [draft.permissions, approveTouched]);

  const setPerm = (id: string, patch: Partial<PermissionDraft>) => setDraft((d) => ({ ...d, permissions: d.permissions.map((p) => (p.id === id ? ({ ...p, ...patch } as PermissionDraft) : p)) }));
  const step = (key: string, p: StepProgress) => setSteps((s) => ({ ...s, [key]: p }));

  const program = () => {
    if (!anchorWallet) throw new Error("no Solana wallet connected");
    const provider = new anchor.AnchorProvider(connection as never, anchorWallet as never, { commitment: "confirmed" });
    return new anchor.Program(idl as anchor.Idl, provider);
  };

  const approve = async (delegate: PublicKey, amount: bigint, key: string) => {
    if (!publicKey) throw new Error("no Solana wallet connected");
    const ownerAta = getAssociatedTokenAddressSync(new PublicKey(mint), publicKey);
    step(key, { state: "pending", note: "reading the current delegate…" });
    const acc = await getAccount(connection, ownerAta);
    const current = acc.delegate?.toBase58() ?? null;
    if (current === delegate.toBase58() && stepSatisfied(acc.delegatedAmount.toString(), amount.toString())) {
      step(key, { state: "satisfied", note: `the PDA is already the delegate for ${acc.delegatedAmount.toString()} base units` });
      return null;
    }
    const tx = new Transaction().add(createApproveInstruction(ownerAta, delegate, publicKey, amount));
    const sig = await sendTransaction(tx, connection);
    step(key, { state: "pending", hash: sig, note: "confirming…" });
    await connection.confirmTransaction(sig, "confirmed");
    step(key, { state: "confirmed", hash: sig, note: `delegated ${amount.toString()} base units to the PDA` });
    return sig;
  };

  const onCreate = async () => {
    if (!validation.ok || !publicKey) return;
    setBusy(true);
    setSteps({});
    setResult(null);
    setFatal(null);
    const agent = new PublicKey(draft.agent.trim());
    const mandate = new PublicKey(derivePda(owner, agent.toBase58()));
    try {
      const prog = program();
      const methods = prog.methods as unknown as Record<string, (...args: unknown[]) => { accountsStrict: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> } }>;
      // 1 of 3: the mandate account
      step("create", { state: "pending" });
      const expiry = Math.floor(Date.now() / 1000) + draft.days * 86400;
      const sig1 = await methods.createMandate(ensNodeBytes(draft.ensName), new anchor.BN(expiry)).accountsStrict({ mandate, owner: publicKey, agent, systemProgram: SystemProgram.programId }).rpc();
      step("create", { state: "confirmed", hash: sig1 });
      // 2 of 3: one add_permission per entry
      for (const [i, p] of draft.permissions.entries()) {
        const key = `perm-${i}`;
        const args = toAddPermissionArgs(p);
        step(key, { state: "pending", note: args.label });
        try {
          const sig = await methods.addPermission(new PublicKey(args.key), args.discriminators, args.size, new anchor.BN(args.spendLimit.toString()), new anchor.BN(args.perTxLimit.toString())).accountsStrict({ mandate, owner: publicKey }).rpc();
          step(key, { state: "confirmed", hash: sig, note: args.label });
        } catch (e) {
          step(key, { state: "failed", note: `${args.label}: ${solanaErrorText(e)}` });
          throw e;
        }
      }
      // 3 of 3: the delegation, or nothing when the PDA already holds enough
      await approve(mandate, BigInt(draft.approveAmount.trim()), "approve");
      // read it back from the chain, decoded the way the SDK's gate client decodes it
      const read = await readMandate(prog, mandate);
      if (read) setResult(read);
    } catch (e) {
      const text = solanaErrorText(e);
      setFatal(text);
      setSteps((s) => {
        const next = { ...s };
        for (const k of Object.keys(next)) if (next[k].state === "pending") next[k] = { ...next[k], state: "failed", note: text };
        if (!next.create) next.create = { state: "failed", note: text };
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  const [existingAmount, setExistingAmount] = useState(existing?.funding?.required ?? "");
  const onDelegateExisting = async () => {
    if (!existing) return;
    setBusy(true);
    setFatal(null);
    try {
      await approve(new PublicKey(existing.pda), BigInt(existingAmount.trim()), "existing");
    } catch (e) {
      const text = solanaErrorText(e);
      setFatal(text);
      step("existing", { state: "failed", note: text });
    } finally {
      setBusy(false);
    }
  };
  const existingStatus = existing?.funding ? fundingStatus(existing.funding) : null;

  return (
    <div className="space-y-4" data-solana-gate={gate.state}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant={gate.enabled ? "allowed" : "neutral"}>{gate.enabled ? "owner connected" : "read only"}</Badge>
        <span className="text-muted" data-testid="solana-gate-reason">{gate.reason}</span>
        <span className="ml-auto"><SolanaConnectButton /></span>
      </div>

      {existing && (
        <Card accent="solana" id="solana-delegate" className="scroll-mt-20">
          <CardHeader>
            <CardTitle>Delegate funds on Solana</CardTitle>
            <CardDescription>{DELEGATION_COPY} On Solana the mandate PDA is the SPL delegate of your token account.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className={cn("rounded-lg border p-3 text-sm space-y-2", existingStatus && (existingStatus.state === "unfunded" || existingStatus.state === "under-funded") && existing.active ? "border-blocked/60 bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_60%)]" : "border-border bg-surface-sunken/70")} data-testid="solana-delegate-row" data-funding={existingStatus?.state ?? "none"}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="solana">Solana</Badge>
                <span className="text-muted">mandate</span> <Addr value={existing.pda} href={CHAINS.solana.address(existing.pda)} />
                {existing.funding && existingStatus && (
                  <>
                    <span className="text-muted">· delegated</span> <Amount chain="solana" units={existing.funding.allowance} />
                    <span className="text-muted">· caps still permit</span> {existing.funding.required === null ? <span>unlimited</span> : <Amount chain="solana" units={existing.funding.required} />}
                    {existingStatus.state === "funded" && <Badge variant="allowed">funded</Badge>}
                    {existingStatus.state === "nothing-to-fund" && <Badge variant="neutral">caps fully spent</Badge>}
                    {(existingStatus.state === "unfunded" || existingStatus.state === "under-funded") && <Badge variant="blocked-solid" className="font-semibold">{existingStatus.state === "unfunded" ? "not funded" : "under-funded"}</Badge>}
                  </>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <label className="text-xs text-muted">
                  delegation to set, in base units of USDC
                  <Input className="mt-1 tnum" value={existingAmount} onChange={(e) => setExistingAmount(e.target.value)} inputMode="numeric" disabled={disabled} data-testid="solana-delegate-amount" />
                  <Conversion units={existingAmount} />
                </label>
                <Button disabled={disabled || !/^\d+$/.test(existingAmount.trim()) || BigInt(existingAmount.trim() || "0") <= 0n} onClick={onDelegateExisting} data-testid="solana-delegate" title={gate.enabled ? undefined : gate.reason}>
                  Delegate funds
                </Button>
              </div>
              {steps.existing && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <StepBadge state={steps.existing.state} />
                  {steps.existing.hash && <Addr value={steps.existing.hash} href={CHAINS.solana.tx(steps.existing.hash)} head={8} tail={6} />}
                  {steps.existing.note && <span className="text-muted">{steps.existing.note}</span>}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card accent="solana" id="solana-create" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Create agent on Solana</CardTitle>
          <CardDescription>Mandate, then one permission per program or payee, then the SPL delegation. Instruction-level: pick which instructions on which program.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">
              agent address
              <Input className="mt-1 mono" value={draft.agent} onChange={(e) => setDraft((d) => ({ ...d, agent: e.target.value }))} placeholder="base58 public key" disabled={disabled} spellCheck={false} data-testid="sol-agent" />
            </label>
            <label className="text-xs text-muted">
              ENS name
              <Input className="mt-1" value={draft.ensName} onChange={(e) => setDraft((d) => ({ ...d, ensName: e.target.value }))} disabled={disabled} spellCheck={false} data-testid="sol-ens" />
            </label>
            <label className="text-xs text-muted">
              expires in days
              <Input className="mt-1 tnum" type="number" min={1} max={365} value={draft.days} onChange={(e) => setDraft((d) => ({ ...d, days: Number(e.target.value) }))} disabled={disabled} data-testid="sol-days" />
            </label>
            <div className="text-xs text-muted">
              mandate PDA
              <div className="mt-1 mono text-ink" data-testid="sol-pda">{pda ? <Addr value={pda} href={CHAINS.solana.address(pda)} head={10} tail={8} /> : <span className="text-muted">enter an agent address</span>}</div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="font-semibold uppercase tracking-wide">permissions</span>
              <span className="tnum" data-testid="sol-perm-count">{draft.permissions.length} / {MAX_PERMISSIONS}</span>
              <span className="ml-auto flex gap-2">
                <Button variant="outline" size="sm" disabled={disabled || draft.permissions.length >= MAX_PERMISSIONS} onClick={() => setDraft((d) => ({ ...d, permissions: [...d.permissions, programPermission("spl-token")] }))} data-testid="sol-add-program"><Plus className="size-3" /> program</Button>
                <Button variant="outline" size="sm" disabled={disabled || draft.permissions.length >= MAX_PERMISSIONS} onClick={() => setDraft((d) => ({ ...d, permissions: [...d.permissions, paymentPermission()] }))} data-testid="sol-add-payment"><Plus className="size-3" /> payee</Button>
              </span>
            </div>
            {draft.permissions.map((p, i) => (
              <PermissionEditor key={p.id} index={i} p={p} disabled={disabled} onChange={(patch) => setPerm(p.id, patch)} onRemove={() => setDraft((d) => ({ ...d, permissions: d.permissions.filter((x) => x.id !== p.id) }))} />
            ))}
          </div>

          <div className="rounded-lg border border-solana/40 bg-solana/5 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="solana">step 3 of 3</Badge>
              <span className="font-medium">Delegate funds</span>
            </div>
            <label className="block text-xs text-muted sm:w-1/2">
              amount to delegate, in base units of USDC
              <Input className="mt-1 tnum" value={draft.approveAmount} onChange={(e) => { setApproveTouched(true); setDraft((d) => ({ ...d, approveAmount: e.target.value })); }} inputMode="numeric" disabled={disabled} data-testid="sol-approve-amount" />
              <Conversion units={draft.approveAmount} />
            </label>
          </div>

          {validation.errors.length > 0 && (
            <ul className="rounded-lg border border-warn/50 bg-warn-soft p-3 text-xs space-y-0.5" data-testid="sol-errors">
              {validation.errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={disabled || !validation.ok} onClick={onCreate} data-testid="sol-create" title={gate.enabled ? undefined : gate.reason}>
              Create mandate · {2 + draft.permissions.length} signatures
            </Button>
            <span className="text-xs text-muted">create_mandate, then add_permission ×{draft.permissions.length}, then approve</span>
          </div>

          <ol className="grid gap-2 sm:grid-cols-3" data-testid="sol-steps">
            {[{ key: "create", n: "1 of 3", title: "Create mandate", call: "create_mandate(ens_node, expiry)" }, ...draft.permissions.map((p, i) => ({ key: `perm-${i}`, n: `2 of 3 · ${i + 1}/${draft.permissions.length}`, title: p.kind === "payment" ? "Add payee" : "Add program permission", call: "add_permission(key, discriminators, width, spend_limit, per_tx_limit)" })), { key: "approve", n: "3 of 3", title: "Delegate funds", call: "spl-token approve(owner ATA → PDA, amount)" }].map((s) => {
              const st = steps[s.key] ?? { state: "idle" as const };
              return (
                <li key={s.key} className={cn("rounded-lg border p-3 text-sm", st.state === "confirmed" || st.state === "satisfied" ? "border-allowed/50 bg-allowed-soft" : st.state === "failed" ? "border-blocked/60 bg-blocked-soft" : st.state === "pending" ? "border-warn/50 bg-warn-soft" : "border-border bg-surface-sunken/70")} data-testid={`sol-step-${s.key}`} data-state={st.state}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted">{s.n}</span>
                    <span className="font-medium">{s.title}</span>
                    <StepBadge state={st.state} />
                  </div>
                  {st.note && <div className="mt-1 text-xs text-muted">{st.note}</div>}
                  {st.hash && <div className="mt-1 text-xs">tx <Addr value={st.hash} href={CHAINS.solana.tx(st.hash)} head={8} tail={6} /></div>}
                </li>
              );
            })}
          </ol>
          {fatal && <div className="rounded-lg border border-blocked bg-[linear-gradient(90deg,var(--blocked-soft)_0%,transparent_60%)] p-3 text-sm text-blocked" data-testid="sol-fatal">{fatal}</div>}

          {result && (
            <div className="rounded-lg border border-allowed/50 bg-allowed-soft p-3 text-sm space-y-2" data-testid="sol-result">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="allowed">mandate live</Badge>
                <Addr value={result.pda} href={CHAINS.solana.address(result.pda)} head={10} tail={8} />
                <span className="text-xs text-muted">expires {new Date(result.expiry * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC · read back from the chain</span>
              </div>
              {result.permissions.map((q) => {
                const prog = catalogueProgram(q.key);
                const isProgram = q.instructions.length > 0;
                return (
                  <div key={q.key} className="rounded-md border border-border bg-surface p-2 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="solana">{isProgram ? "verify" : "execute_payment"}</Badge>
                      <span>{isProgram ? (prog?.name ?? "program") : "pay"}</span>
                      <Addr value={q.key} href={CHAINS.solana.address(q.key)} />
                      <span className="text-xs text-muted tnum">per tx <Amount chain="solana" units={q.perTx} secondary="none" /> · lifetime <Amount chain="solana" units={q.total} secondary="none" /></span>
                    </div>
                    {isProgram && (
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="text-muted">allowed:</span>
                        {q.instructions.map((h) => <Badge key={h} variant="allowed">{describeDiscriminator(q.key, h, q.width as 1 | 4 | 8)}</Badge>)}
                        {notPermitted(q.key, q.instructions, q.width as 1 | 4 | 8).length > 0 && <span className="text-muted">· not allowed:</span>}
                        {notPermitted(q.key, q.instructions, q.width as 1 | 4 | 8).map((i) => <Badge key={i.name} variant="blocked">{i.name} ({i.tag})</Badge>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PermissionEditor({ index, p, disabled, onChange, onRemove }: { index: number; p: PermissionDraft; disabled: boolean; onChange: (patch: Partial<PermissionDraft>) => void; onRemove: () => void }) {
  const [advanced, setAdvanced] = useState(p.kind === "program" && p.program === "custom");
  if (p.kind === "payment") {
    return (
      <div className="rounded-lg border border-border bg-surface-sunken/70 p-3 space-y-2" data-testid={`sol-perm-${index}`} data-kind="payment">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="solana">payee</Badge>
          <span className="font-medium">execute_payment to a token account</span>
          <Button variant="ghost" size="sm" className="ml-auto" disabled={disabled} onClick={onRemove} aria-label="remove"><Trash2 className="size-3.5" /></Button>
        </div>
        <label className="block text-xs text-muted">
          destination token account (base58)
          <Input className="mt-1 mono" value={p.destination} onChange={(e) => onChange({ destination: e.target.value } as Partial<PermissionDraft>)} disabled={disabled} spellCheck={false} data-testid={`sol-perm-${index}-destination`} />
        </label>
        <Caps p={p} disabled={disabled} onChange={onChange} index={index} />
      </div>
    );
  }
  const prog = catalogueProgram(p.program);
  const count = (() => {
    try {
      return permissionDiscriminators(p).length;
    } catch {
      return p.tags.length + p.customHex.length;
    }
  })();
  const toggleTag = (tag: number) => onChange({ tags: p.tags.includes(tag) ? p.tags.filter((t) => t !== tag) : [...p.tags, tag] } as Partial<PermissionDraft>);
  return (
    <div className="rounded-lg border border-border bg-surface-sunken/70 p-3 space-y-2" data-testid={`sol-perm-${index}`} data-kind="program">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="solana">program</Badge>
        <span className="font-medium">verify: which instructions on which program</span>
        <span className="text-xs text-muted tnum" data-testid={`sol-perm-${index}-count`}>{count} / {MAX_DISCRIMINATORS} instructions</span>
        <Button variant="ghost" size="sm" className="ml-auto" disabled={disabled} onClick={onRemove} aria-label="remove"><Trash2 className="size-3.5" /></Button>
      </div>
      <label className="block text-xs text-muted sm:w-1/2">
        program
        <select
          className="mt-1 h-10 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm"
          value={p.program}
          disabled={disabled}
          data-testid={`sol-perm-${index}-program`}
          onChange={(e) => {
            const key = e.target.value;
            const c = catalogueProgram(key);
            setAdvanced(key === "custom");
            onChange({ program: key, programId: c?.id ?? "", width: c?.width ?? 8, tags: c ? [c.instructions[0].tag] : [], customHex: [] } as Partial<PermissionDraft>);
          }}
        >
          {PROGRAM_CHOICES.map((c) => <option key={c.key} value={c.key}>{c.name} · {c.width}-byte discriminators</option>)}
          <option value="custom">Custom program (advanced)</option>
        </select>
      </label>
      {prog && (
        <div className="grid gap-1 sm:grid-cols-2" data-testid={`sol-perm-${index}-instructions`}>
          {prog.instructions.map((ins) => {
            const on = p.tags.includes(ins.tag);
            return (
              <label key={ins.tag} className={cn("flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm cursor-pointer", on ? "border-allowed/50 bg-allowed-soft" : "border-border bg-surface")}>
                <input type="checkbox" className="mt-1" checked={on} disabled={disabled} onChange={() => toggleTag(ins.tag)} data-testid={`sol-perm-${index}-tag-${ins.tag}`} />
                <span className="min-w-0">
                  <span className="font-medium">{ins.name}</span> <span className="mono text-[11px] text-muted">tag {ins.tag}</span>
                  {ins.risk ? (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-warn"><AlertTriangle className="size-3 shrink-0" /> {ins.risk}</span>
                  ) : (
                    <span className="mt-0.5 block text-xs text-muted">{ins.label} · ordinary</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
      <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)} className="text-xs">
        <summary className="cursor-pointer text-muted">Advanced: custom program id, discriminator width and raw discriminators</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <label className="text-muted sm:col-span-2">
            program id
            <Input className="mt-1 mono" value={p.programId} onChange={(e) => onChange({ programId: e.target.value, program: catalogueProgram(e.target.value.trim())?.key ?? "custom" } as Partial<PermissionDraft>)} disabled={disabled} spellCheck={false} data-testid={`sol-perm-${index}-program-id`} />
          </label>
          <label className="text-muted">
            width (bytes the gate compares)
            <select className="mt-1 h-10 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm" value={p.width} disabled={disabled} onChange={(e) => onChange({ width: Number(e.target.value) as 1 | 4 | 8 } as Partial<PermissionDraft>)} data-testid={`sol-perm-${index}-width`}>
              <option value={1}>1 · SPL Token tag</option>
              <option value={4}>4 · System Program u32</option>
              <option value={8}>8 · Anchor</option>
            </select>
          </label>
          <label className="text-muted sm:col-span-3">
            raw discriminators, hex, one per line, each exactly {p.width} byte{p.width === 1 ? "" : "s"} (an Anchor discriminator is sha256(&quot;global:&lt;name&gt;&quot;)[0..8])
            <textarea className="mt-1 w-full rounded-md border border-border bg-surface-sunken px-3 py-2 mono text-xs" rows={2} value={p.customHex.join("\n")} onChange={(e) => onChange({ customHex: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) } as Partial<PermissionDraft>)} disabled={disabled} spellCheck={false} data-testid={`sol-perm-${index}-custom`} />
          </label>
        </div>
      </details>
      <Caps p={p} disabled={disabled} onChange={onChange} index={index} />
      {p.programId === SPL_TOKEN_PROGRAM && p.tags.length === 1 && p.tags[0] === 3 && <div className="text-xs text-allowed">Transfer only: the ordinary grant. Everything else on SPL Token is refused with 6006 InstructionNotAllowed.</div>}
    </div>
  );
}

function Caps({ p, disabled, onChange, index }: { p: PermissionDraft; disabled: boolean; onChange: (patch: Partial<PermissionDraft>) => void; index: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs text-muted">
        per-transaction cap, in base units of USDC
        <Input className="mt-1 tnum" value={p.perTx} onChange={(e) => onChange({ perTx: e.target.value } as Partial<PermissionDraft>)} inputMode="numeric" disabled={disabled} data-testid={`sol-perm-${index}-pertx`} />
        <Conversion units={p.perTx} />
      </label>
      <label className="text-xs text-muted">
        lifetime cap, in base units of USDC
        <Input className="mt-1 tnum" value={p.total} onChange={(e) => onChange({ total: e.target.value } as Partial<PermissionDraft>)} inputMode="numeric" disabled={disabled} data-testid={`sol-perm-${index}-total`} />
        <Conversion units={p.total} />
      </label>
    </div>
  );
}

export { AGENTRAIL_PROGRAM };
