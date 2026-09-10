import { Badge } from "@/components/ui/badge";
import { CHAINS, type ChainKey } from "@/lib/chains";

export function ChainBadge({ chain, long = false }: { chain: ChainKey | string; long?: boolean }) {
  const meta = CHAINS[chain as ChainKey];
  if (!meta) return <Badge>{chain}</Badge>;
  return <Badge variant={meta.color}>{long ? meta.label : meta.short}</Badge>;
}
