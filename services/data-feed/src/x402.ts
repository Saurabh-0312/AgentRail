/**
 * x402 v2 over the facilitator HTTP protocol: GET /supported -> POST /verify -> POST /settle.
 * The server is the only party that ever calls /settle, exactly once per payment.
 * Confirmation comes from the Hedera Mirror Node, never from the facilitator's own claim.
 */

export const HEDERA_TESTNET = "hedera:testnet";
export const HBAR_ASSET = "0.0.0";
export const HTS_USDC_TESTNET = "0.0.429274";

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  resource?: string;
  description?: string;
  extra: { feePayer: string; [k: string]: unknown };
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  accepted: PaymentRequirements;
  payload: unknown;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  transaction?: string;
  transactionId?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

/** The three facilitator calls the service depends on. Injected so tests never touch the network. */
export interface Facilitator {
  feePayer(network: string): Promise<string>;
  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResult>;
  settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResult>;
}

export function httpFacilitator(baseUrl: string): Facilitator {
  const base = baseUrl.replace(/\/$/, "");
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json().catch(() => ({}))) as T;
  };
  return {
    async feePayer(network) {
      const supported = (await (await fetch(`${base}/supported`)).json()) as {
        kinds?: { network: string; scheme: string; extra?: { feePayer?: string } }[];
        signers?: Record<string, string[]>;
      };
      const kind = supported.kinds?.find((k) => k.network === network && k.scheme === "exact");
      const family = network.split(":")[0] + ":*";
      const feePayer = kind?.extra?.feePayer ?? supported.signers?.[family]?.[0];
      if (!feePayer) throw new Error(`facilitator ${base} does not serve ${network}`);
      return feePayer;
    },
    verify: (paymentPayload, paymentRequirements) =>
      post<VerifyResult>("/verify", { x402Version: 2, paymentPayload, paymentRequirements }),
    settle: (paymentPayload, paymentRequirements) =>
      post<SettleResult>("/settle", { x402Version: 2, paymentPayload, paymentRequirements }),
  };
}

export const encodeB64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

export function decodePaymentHeader(raw: string | undefined): PaymentPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.x402Version !== 2 || !parsed.accepted || !parsed.payload) return null;
    return parsed as PaymentPayload;
  } catch {
    return null;
  }
}

/** `0.0.7162784@1788889346.864779084` -> `0.0.7162784-1788889346-864779084` (Mirror Node / HashScan form). */
export const toMirrorId = (txId: string) => String(txId).replace("@", "-").replace(/\.(\d+)$/, "-$1");

export const hashscanUrl = (txId: string) => `https://hashscan.io/testnet/transaction/${toMirrorId(txId)}`;

export interface MirrorConfirmation {
  transactionId: string;
  result: string;
  name: string;
  consensusTimestamp: string;
  chargedTxFee: number;
}

/** Look the settlement up on the Mirror Node. Returns null while it is not yet visible. */
export async function mirrorConfirm(
  txId: string,
  mirrorBase = "https://testnet.mirrornode.hedera.com",
): Promise<MirrorConfirmation | null> {
  try {
    const r = await fetch(`${mirrorBase}/api/v1/transactions/${encodeURIComponent(toMirrorId(txId))}`);
    if (!r.ok) return null;
    const d = (await r.json()) as {
      transactions?: { transaction_id: string; result: string; name: string; consensus_timestamp: string; charged_tx_fee: number }[];
    };
    const hit = d.transactions?.find((t) => String(t.name).includes("CRYPTOTRANSFER"));
    return hit
      ? {
          transactionId: hit.transaction_id,
          result: hit.result,
          name: hit.name,
          consensusTimestamp: hit.consensus_timestamp,
          chargedTxFee: hit.charged_tx_fee,
        }
      : null;
  } catch {
    return null;
  }
}
