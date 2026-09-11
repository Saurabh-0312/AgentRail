"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

/** Connect the owner's Solana wallet: the first installed one (Phantom or any Wallet Standard wallet). */
export function SolanaConnectButton() {
  const { wallets, wallet, select, connect, disconnect, publicKey, connecting, connected } = useWallet();
  const [wanted, setWanted] = useState<string | null>(null);
  // wallets are detected in the browser only; until mounted, render exactly what the server rendered
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // `select` is state; connecting in the same tick as selecting throws WalletNotSelectedError
  useEffect(() => {
    if (!wanted || !wallet || wallet.adapter.name !== wanted || connected || connecting) return;
    connect().catch(() => {}).finally(() => setWanted(null));
  }, [wanted, wallet, connected, connecting, connect]);
  if (publicKey) {
    return (
      <Button variant="outline" size="sm" onClick={() => disconnect()} data-testid="solana-disconnect">
        <span className="mono">{publicKey.toBase58().slice(0, 4)}…{publicKey.toBase58().slice(-4)}</span> · disconnect
      </Button>
    );
  }
  const available = mounted ? (wallets.find((w) => w.readyState === "Installed") ?? wallets.find((w) => w.readyState === "Loadable")) : undefined;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!available || connecting || wanted !== null}
      data-testid="solana-connect"
      onClick={() => {
        if (!available) return;
        setWanted(available.adapter.name);
        select(available.adapter.name);
      }}
    >
      {connecting || wanted ? "connecting…" : available ? `Connect ${available.adapter.name}` : mounted ? "No Solana wallet found" : "Connect Solana wallet"}
    </Button>
  );
}
