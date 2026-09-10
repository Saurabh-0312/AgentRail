import { cn } from "@/lib/cn";
import { ASSETS, formatChainAmount, tryFormatUnits, type AssetKey, type FormattedUnits } from "@/lib/units";

/**
 * Every amount on the site. The human value is the figure; the base units are the small print
 * (inline, stacked under it, or only in the tooltip), so a judge reads "0.03 USDC" and a
 * developer can still see 30,000.
 */
export function Amount({
  chain,
  asset,
  units,
  secondary = "inline",
  fallback = "—",
  className,
}: {
  /** Either the chain (its mandate asset) or an explicit asset. */
  chain?: string;
  asset?: AssetKey;
  units: string | number | bigint | null | undefined;
  secondary?: "inline" | "below" | "tooltip" | "none";
  fallback?: string;
  className?: string;
}) {
  const f = asset ? tryFormatUnits(units, ASSETS[asset].decimals, ASSETS[asset].symbol) : chain ? formatChainAmount(chain, units) : null;
  if (!f) return <span className={cn("tnum", className)}>{units === null || units === undefined || units === "" ? fallback : String(units)}</span>;
  return <Figure f={f} secondary={secondary} className={className} />;
}

export function Figure({ f, secondary = "inline", className }: { f: FormattedUnits; secondary?: "inline" | "below" | "tooltip" | "none"; className?: string }) {
  const raw = `${f.raw} base units`;
  if (secondary === "none") return <span className={cn("tnum", className)}>{f.human}</span>;
  if (secondary === "tooltip") {
    return (
      <span className={cn("tnum", className)} title={raw}>
        {f.human}
      </span>
    );
  }
  return (
    <span className={cn("tnum", secondary === "below" ? "inline-flex flex-col leading-tight" : "inline-flex flex-wrap items-baseline gap-x-1.5", className)} title={raw}>
      <span className="whitespace-nowrap">{f.human}</span>
      <span className="whitespace-nowrap text-[11px] text-muted">{f.raw} units</span>
    </span>
  );
}
