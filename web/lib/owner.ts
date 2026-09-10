/**
 * Owner gating, as a pure function so it is tested without a wallet. An action is enabled only
 * when the connected address IS the owner; every other state carries the one-line explanation the
 * visitor sees next to the disabled control.
 */
export interface OwnerGate {
  enabled: boolean;
  /** Why the control is in the state it is in. Shown next to it. */
  reason: string;
  state: "disconnected" | "wrong-account" | "owner";
}

export function ownerGate(connected: string | undefined | null, owner: string): OwnerGate {
  if (!connected) {
    return { enabled: false, state: "disconnected", reason: `Needs the owner's wallet (${short(owner)}). Connect it to enable these; a visitor can see them but not press them.` };
  }
  if (connected.toLowerCase() !== owner.toLowerCase()) {
    return { enabled: false, state: "wrong-account", reason: `Connected as ${short(connected)}, which is not the owner ${short(owner)}. Only the owner's key can revoke or issue a mandate.` };
  }
  return { enabled: true, state: "owner", reason: `Connected as the owner ${short(owner)}.` };
}

export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** Default caps for a new EVM mandate, in the token's base units (USDC, 6 decimals). */
export const CREATE_DEFAULTS = { perTx: "30000", total: "50000", days: 30 };
