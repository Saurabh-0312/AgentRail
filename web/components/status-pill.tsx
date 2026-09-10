import { Badge } from "@/components/ui/badge";

export type MandateStatus = "active" | "revoked" | "expired" | "missing";

export function statusOf(m: { exists: boolean; active: boolean; expiry: number } | undefined, now = Date.now() / 1000): MandateStatus {
  if (!m || !m.exists) return "missing";
  if (!m.active) return "revoked";
  if (m.expiry && m.expiry <= now) return "expired";
  return "active";
}

export function StatusPill({ status }: { status: MandateStatus }) {
  const variant = status === "active" ? "allowed" : status === "expired" ? "warn" : "blocked";
  const label = status === "missing" ? "no mandate" : status;
  return <Badge variant={variant}>{label}</Badge>;
}
