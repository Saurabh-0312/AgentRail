"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { defineChain } from "viem";
import { WagmiProvider, createConfig, http } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

/** Hedera testnet as an EVM chain, through its public JSON-RPC relay. Public URL, no key. */
export const hederaTestnet = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hashio.io/api"] } },
  blockExplorers: { default: { name: "HashScan", url: "https://hashscan.io/testnet" } },
  testnet: true,
});

export const wagmiConfig = createConfig({
  chains: [baseSepolia, hederaTestnet],
  connectors: [injected()],
  transports: { [baseSepolia.id]: http("https://sepolia.base.org"), [hederaTestnet.id]: http("https://testnet.hashio.io/api") },
  ssr: true,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
