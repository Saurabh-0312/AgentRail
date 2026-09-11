"use client";

import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { useMemo, type ReactNode } from "react";

/** The public devnet endpoint: the browser reads state and sends what the wallet signed, nothing else. */
export const SOLANA_ENDPOINT = "https://api.devnet.solana.com";

/**
 * A Solana wallet is a separate connection from the EVM one: a mandate on Solana is signed by the
 * owner's Solana key. Phantom is listed explicitly; any Wallet Standard wallet (Solflare, Backpack)
 * is picked up by the adapter as well. No key is ever held by the app.
 */
export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={SOLANA_ENDPOINT} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
