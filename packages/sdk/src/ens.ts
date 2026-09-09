/**
 * ENS text reads over ENSv2 on Sepolia. Resolution goes through the UniversalResolver, which walks
 * the registries (RootRegistry -> ETHRegistry -> AgentRailRegistry) to find the name's resolver.
 * The only address here is ENS's own resolver-of-resolvers; nothing about a service is hardcoded.
 */
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";

import type { EnsTextReader } from "./discovery.ts";

/** ensdomains/contracts-v2 :: deployments/sepolia/UniversalResolverV2 */
export const SEPOLIA_ENSV2_UNIVERSAL_RESOLVER: Address = "0x85edf8b6b7d4211e2b07aa687506b746357b92cf";

export function ensTextReader(client: PublicClient, universalResolverAddress: Address = SEPOLIA_ENSV2_UNIVERSAL_RESOLVER): EnsTextReader {
  return (name, key) => client.getEnsText({ name: normalize(name), key, universalResolverAddress });
}

export function sepoliaEnsReader(rpcUrl: string, universalResolverAddress?: Address): EnsTextReader {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  return ensTextReader(client, universalResolverAddress);
}
