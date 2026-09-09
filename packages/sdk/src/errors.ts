/** The mandate said no. Thrown by `authorize` before any facilitator or service is contacted. */
export class MandateRefused extends Error {
  readonly chain: string;
  /** The Solana error name / EVM custom error name, e.g. PerTxLimitExceeded. */
  readonly reason: string;
  readonly detail?: unknown;
  constructor(chain: string, reason: string, detail?: unknown) {
    super(`mandate refused on ${chain}: ${reason}`);
    this.name = "MandateRefused";
    this.chain = chain;
    this.reason = reason;
    this.detail = detail;
  }
}

/** The service did not answer with a usable x402 challenge. */
export class BadChallenge extends Error {
  readonly status?: number;
  readonly body?: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "BadChallenge";
    this.status = status;
    this.body = body;
  }
}

/** The gate passed but the settlement step did not. */
export class SettlementFailed extends Error {
  readonly body?: unknown;
  constructor(message: string, body?: unknown) {
    super(message);
    this.name = "SettlementFailed";
    this.body = body;
  }
}
