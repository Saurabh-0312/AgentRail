"use client";

import * as anchor from "@coral-xyz/anchor";
import idl from "@agentrail/sdk/src/solana/agentrail.idl.json";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Addr } from "@/components/addr";
import { ChainBadge } from "@/components/chain-badge";
import { solanaOwnerGate } from "@/components/solana-create";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CHAINS } from "@/lib/chains";
import type { StepProgress } from "@/lib/delegation";
import { REVOKE_WARNING, revokeErrorText, revokeGate, type RevokeRead } from "@/lib/solana-revoke";

const untilExpiry = (expiry: number) => {
  const s = expiry - Math.floor(Date.now() / 1000);
  if (s <= 0) return "expired";
  const h = Math.floor(s / 3600);
  return h >= 48 ? `expires in ${Math.floor(h / 24)} d` : `expires in ${h} h ${Math.floor((s % 3600) / 60)} min`;
};

/** The row, as pure markup: the same rhythm as the EVM revoke rows above it. */
export function SolanaRevokeView({ pda, mandate, gate, confirm, progress, onArm, onConfirm, onCancel }: { pda: string; mandate: RevokeRead | null | "loading"; gate: ReturnType<typeof revokeGate>; confirm: boolean; progress: StepProgress | null; onArm: () => void; onConfirm: () => void; onCancel: () => void }) {
  const busy = progress?.state === "pending";
  const can = gate.enabled && !busy;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-sunken/70 p-3 text-sm" data-testid="solana-revoke-row" data-state={gate.state}>
      <div className="flex flex-wrap items-center gap-3">
        <ChainBadge chain="solana" />
        <span className="text-muted">mandate</span> <Addr value={pda} href={CHAINS.solana.address(pda)} />
        {mandate === "loading" ? (
          <Badge variant="neutral">reading…</Badge>
        ) : mandate ? (
          <>
            <Badge variant={mandate.active ? "allowed" : "blocked"}>{mandate.active ? "active" : "inactive"}</Badge>
            <span className="text-xs text-muted tnum" data-testid="solana-revoke-state">{untilExpiry(mandate.expiry)} · {mandate.permissions} permission{mandate.permissions === 1 ? "" : "s"}</span>
          </>
        ) : (
          <Badge variant="blocked">no account</Badge>
        )}
        <span className="ml-auto flex items-center gap-2">
          {confirm ? (
            <>
              <span className="text-xs text-blocked" data-testid="solana-revoke-warning">{REVOKE_WARNING}</span>
              <Button variant="danger" size="sm" disabled={!can} onClick={onConfirm} data-testid="revoke-solana-confirm">yes, close it</Button>
              <Button variant="outline" size="sm" onClick={onCancel}>cancel</Button>
            </>
          ) : (
            <Button variant="danger" size="sm" disabled={!can} onClick={onArm} data-testid="revoke-solana" title={gate.enabled ? undefined : gate.reason}>
              REVOKE SOLANA
            </Button>
          )}
        </span>
      </div>
      <div className="text-xs text-muted" data-testid="solana-revoke-reason">
        {gate.enabled ? <>{gate.reason} Closes the account for good: recreating it means create, permission and delegation again.</> : gate.reason}
      </div>
      {progress && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="solana-revoke-progress" data-progress={progress.state}>
          {progress.state === "pending" ? <Badge variant="warn">pending…</Badge> : progress.state === "confirmed" ? <Badge variant="allowed">closed</Badge> : <Badge variant="blocked-solid">failed</Badge>}
          {progress.hash && <Addr value={progress.hash} href={CHAINS.solana.tx(progress.hash)} head={8} tail={6} />}
          {progress.note && <span className={progress.state === "failed" ? "text-blocked" : "text-muted"}>{progress.note}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The owner's kill switch on Solana. Reads the account live (it may have been closed since the
 * page rendered), gates on the connected wallet, requires an explicit confirm, then sends
 * `revoke_mandate` signed in the browser. On success the page is refreshed so the mandate reads
 * as gone and the create form offers a fresh one. No key on the server: Phantom signs.
 */
export function SolanaRevoke({ owner, pda, initial }: { owner: string; pda: string; initial: RevokeRead | null }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const router = useRouter();
  const [mandate, setMandate] = useState<RevokeRead | null | "loading">(initial);
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<StepProgress | null>(null);
  const wallet = solanaOwnerGate(publicKey?.toBase58() ?? null, owner);
  const gate = revokeGate(wallet, mandate);

  const read = async (): Promise<RevokeRead | null> => {
    const prog = new anchor.Program(idl as anchor.Idl, { connection } as never);
    const accounts = prog.account as unknown as Record<string, { fetchNullable: (k: PublicKey) => Promise<Record<string, unknown> | null> }>;
    const m = await accounts.mandateAccount.fetchNullable(new PublicKey(pda));
    return m ? { active: Number(m.active) === 1, expiry: Number(m.expiry), permissions: Number(m.permissionsLen) } : null;
  };

  // the server's read may be stale by the time the owner looks: re-read once on mount
  useEffect(() => {
    let alive = true;
    read().then((m) => alive && setMandate(m)).catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pda]);

  const onConfirm = async () => {
    setConfirm(false);
    if (!gate.enabled || !anchorWallet || !publicKey) return;
    setProgress({ state: "pending", note: "checking the account still exists…" });
    try {
      const current = await read();
      if (!current) {
        setMandate(null);
        setProgress({ state: "failed", note: "no Solana mandate to revoke: the account does not exist" });
        return;
      }
      const provider = new anchor.AnchorProvider(connection as never, anchorWallet as never, { commitment: "confirmed" });
      const prog = new anchor.Program(idl as anchor.Idl, provider);
      const methods = prog.methods as unknown as Record<string, () => { accountsStrict: (a: Record<string, PublicKey>) => { rpc: () => Promise<string> } }>;
      setProgress({ state: "pending", note: "sign revoke_mandate in your wallet…" });
      const sig = await methods.revokeMandate().accountsStrict({ mandate: new PublicKey(pda), owner: publicKey }).rpc();
      setProgress({ state: "confirmed", hash: sig, note: "the account is closed; its lamports went back to the owner" });
      setMandate(null);
      router.refresh();
    } catch (e) {
      setProgress({ state: "failed", note: revokeErrorText(e, owner) });
    }
  };

  return <SolanaRevokeView pda={pda} mandate={mandate} gate={gate} confirm={confirm} progress={progress} onArm={() => setConfirm(true)} onConfirm={onConfirm} onCancel={() => setConfirm(false)} />;
}
