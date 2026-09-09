import { toFunctionSelector } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  AdapterRegistry,
  BaseAdapter,
  CHAINS,
  HederaAdapter,
  MandateRefused,
  SolanaAdapter,
  X402_NETWORK,
  hederaLongZeroAddress,
  solanaLocalGate,
  type EvmGateClient,
  type PaymentAdapter,
  type PaymentRequirements,
  type SolanaGateClient,
  type SolanaMandateState,
} from "../src/index.ts";

const MANDATE = "0x68822ce9109D9d71e99b07703cF6c851D0229AA9" as const;
const AGENT_EVM = "0x0F072339A79E72A78A0535bB9132228C8B8B1fF0" as const;
const AGENT_SOL = "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV";
const MANDATE_ID = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const PDA = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";
const SHOP_ATA = "6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a";
const NO_ERROR = "0x00000000";
const sel = (name: string) => toFunctionSelector(`${name}()`);

function requirementsFor(chain: keyof typeof X402_NETWORK, amount: string, payTo: string, asset: string): PaymentRequirements {
  return { scheme: "exact", network: X402_NETWORK[chain], amount, payTo, asset, maxTimeoutSeconds: 300, resource: "https://feed/price/SOL", extra: { feePayer: "0.0.7162784" } };
}

/** A fetch that answers 402 on the first call and 200 on a paid retry. Every call is recorded. */
function fakeService(requirements: PaymentRequirements, txId = "0.0.7162784@1.2") {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers });
    if (!init?.headers?.["X-PAYMENT"]) {
      return new Response(JSON.stringify({ x402Version: 2, error: "PAYMENT_REQUIRED", accepts: [requirements] }), { status: 402 });
    }
    return new Response(JSON.stringify({ data: [{ symbol: "SOL", price: 1 }], payment: { transactionId: txId } }), {
      status: 200,
      headers: { "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: txId, payer: "0.0.4863756" })).toString("base64") },
    });
  });
  return { fetchImpl, calls };
}

function fakeEvmClient(checkResult: string = NO_ERROR) {
  const client = {
    readContract: vi.fn(async () => checkResult as `0x${string}`),
    writeContract: vi.fn(async () => "0xabc" as `0x${string}`),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success" as const })),
  };
  return client as EvmGateClient & typeof client;
}

const fakeSigner = () => ({ createPaymentPayload: vi.fn(async () => ({ payload: { transaction: "AAAA" } })) });

function mandateState(overrides: Partial<SolanaMandateState> = {}): SolanaMandateState {
  return {
    active: true,
    expiry: 4_000_000_000n,
    agent: AGENT_SOL,
    permissions: [{ key: SHOP_ATA, spendLimit: 5_000_000n, perTxLimit: 2_000_000n, spendTotal: 4_500_000n }],
    ...overrides,
  };
}

function fakeSolanaClient(state: SolanaMandateState | null = mandateState()) {
  const client = {
    readMandate: vi.fn(async () => state),
    destinationTokenAccount: vi.fn(async () => SHOP_ATA),
    buildExecutePayment: vi.fn(async () => new Uint8Array([1, 2, 3])),
    send: vi.fn(async () => "5ig"),
    now: vi.fn(async () => 1_800_000_000n),
  };
  return client as SolanaGateClient & typeof client;
}

// ---- the contract every tail satisfies -----------------------------------------------------

describe("adapter contract", () => {
  const tails: { name: string; make: () => PaymentAdapter; chain: string }[] = [
    { name: "hedera", chain: CHAINS.HEDERA_TESTNET, make: () => new HederaAdapter({ mandateContract: MANDATE, agent: AGENT_EVM, client: fakeEvmClient(), signer: fakeSigner(), fetch: fakeService(requirementsFor("hedera:testnet", "30000", "0.0.10440535", "0.0.429274")).fetchImpl }) },
    { name: "base", chain: CHAINS.BASE_SEPOLIA, make: () => new BaseAdapter({ mandateContract: MANDATE, agent: AGENT_EVM, client: fakeEvmClient(), signer: fakeSigner(), fetch: fakeService(requirementsFor("eip155:84532", "10000", "0x000000000000000000000000000000000000dEaD", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"), "0xdeadbeef").fetchImpl }) },
    { name: "solana", chain: CHAINS.SOLANA_DEVNET, make: () => new SolanaAdapter({ agent: AGENT_SOL, client: fakeSolanaClient(mandateState({ permissions: [{ key: SHOP_ATA, spendLimit: 5_000_000n, perTxLimit: 2_000_000n, spendTotal: 0n }] })), fetch: fakeService(requirementsFor("solana:devnet", "1500000", "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")).fetchImpl }) },
  ];

  for (const t of tails) {
    it(`${t.name}: exposes chain, quote, authorize, settle and runs them in order`, async () => {
      const adapter = t.make();
      expect(adapter.chain).toBe(t.chain);
      expect(typeof adapter.quote).toBe("function");
      expect(typeof adapter.authorize).toBe("function");
      expect(typeof adapter.settle).toBe("function");

      const quote = await adapter.quote({ chain: adapter.chain, url: "https://feed/price/SOL" });
      expect(quote.chain).toBe(t.chain);
      expect(quote.amount).toBeGreaterThan(0n);
      expect(quote.requirements.network).toBe(X402_NETWORK[adapter.chain]);

      const auth = await adapter.authorize({ chain: adapter.chain, id: t.name === "solana" ? PDA : MANDATE_ID }, quote);
      expect(auth.chain).toBe(t.chain);
      expect(auth.gate.kind).toMatch(/evm-authorize|solana-execute-payment/);

      const settlement = await adapter.settle(auth);
      expect(settlement.chain).toBe(t.chain);
      expect(settlement.transactionId).toBeTruthy();
      const expected = t.name === "hedera" ? settlement.transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1") : settlement.transactionId;
      expect(settlement.explorer).toContain(expected);
    });
  }

  it("registry selects by chain id and refuses unknown chains", () => {
    const registry = new AdapterRegistry()
      .register(CHAINS.HEDERA_TESTNET, tails[0].make)
      .register(CHAINS.BASE_SEPOLIA, tails[1].make)
      .register(CHAINS.SOLANA_DEVNET, tails[2].make);
    expect(registry.chains().sort()).toEqual([CHAINS.BASE_SEPOLIA, CHAINS.HEDERA_TESTNET, CHAINS.SOLANA_DEVNET].sort());
    expect(registry.select("hedera:testnet").chain).toBe("hedera:testnet");
    expect(registry.select("eip155:84532").chain).toBe("eip155:84532");
    expect(registry.select("solana:devnet").chain).toBe("solana:devnet");
    expect(() => registry.select("eip155:1")).toThrow(/no payment adapter/);
  });

  it("quote refuses a service that does not answer 402 for our chain", async () => {
    const wrongChain = fakeService(requirementsFor("eip155:84532", "1", "0x000000000000000000000000000000000000dEaD", "0x0"));
    const adapter = new HederaAdapter({ mandateContract: MANDATE, agent: AGENT_EVM, client: fakeEvmClient(), signer: fakeSigner(), fetch: wrongChain.fetchImpl });
    await expect(adapter.quote({ chain: "hedera:testnet", url: "https://feed/price/SOL" })).rejects.toThrow(/does not accept hedera:testnet/);
  });
});

// ---- the gate runs before any facilitator or service is contacted --------------------------

describe("authorize refuses over-cap before any network call", () => {
  const evmCases: [string, string][] = [
    ["PerTxLimitExceeded", sel("PerTxLimitExceeded")],
    ["SpendLimitExceeded", sel("SpendLimitExceeded")],
    ["DestinationNotAllowed", sel("DestinationNotAllowed")],
    ["Expired", sel("Expired")],
    ["NotActive", sel("NotActive")],
    ["NotTheAgent", sel("NotTheAgent")],
  ];

  for (const [reason, selector] of evmCases) {
    it(`hedera: ${reason} -> MandateRefused, no signing, no authorize tx, no paid request`, async () => {
      const service = fakeService(requirementsFor("hedera:testnet", "30000", "0.0.10440535", "0.0.429274"));
      const client = fakeEvmClient(selector);
      const signer = fakeSigner();
      const adapter = new HederaAdapter({ mandateContract: MANDATE, agent: AGENT_EVM, client, signer, fetch: service.fetchImpl });
      const quote = await adapter.quote({ chain: "hedera:testnet", url: "https://feed/price/SOL" });
      const callsAfterQuote = service.calls.length;

      const err = await adapter.authorize({ chain: "hedera:testnet", id: MANDATE_ID }, quote).catch((e) => e);
      expect(err).toBeInstanceOf(MandateRefused);
      expect((err as MandateRefused).reason).toBe(reason);
      expect(client.readContract).toHaveBeenCalledTimes(1);
      expect(client.writeContract).not.toHaveBeenCalled();
      expect(signer.createPaymentPayload).not.toHaveBeenCalled();
      expect(service.calls.length).toBe(callsAfterQuote); // nothing after the unpaid quote
      expect(service.calls.every((c) => !c.headers?.["X-PAYMENT"])).toBe(true);
    });
  }

  it("base: refusal happens the same way", async () => {
    const service = fakeService(requirementsFor("eip155:84532", "10000", "0x000000000000000000000000000000000000dEaD", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
    const client = fakeEvmClient(sel("SpendLimitExceeded"));
    const signer = fakeSigner();
    const adapter = new BaseAdapter({ mandateContract: MANDATE, agent: AGENT_EVM, client, signer, fetch: service.fetchImpl });
    const quote = await adapter.quote({ chain: "eip155:84532", url: "https://graph/query" });
    await expect(adapter.authorize({ chain: "eip155:84532", id: MANDATE_ID }, quote)).rejects.toMatchObject({ reason: "SpendLimitExceeded" });
    expect(client.writeContract).not.toHaveBeenCalled();
    expect(signer.createPaymentPayload).not.toHaveBeenCalled();
    expect(service.calls.filter((c) => c.headers?.["X-PAYMENT"])).toHaveLength(0);
  });

  it("evm: a reverted authorize tx is a refusal and no payment is signed", async () => {
    const service = fakeService(requirementsFor("hedera:testnet", "30000", "0.0.10440535", "0.0.429274"));
    const client = fakeEvmClient();
    client.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });
    const signer = fakeSigner();
    const adapter = new HederaAdapter({ mandateContract: MANDATE, agent: AGENT_EVM, client, signer, fetch: service.fetchImpl });
    const quote = await adapter.quote({ chain: "hedera:testnet", url: "https://feed/price/SOL" });
    await expect(adapter.authorize({ chain: "hedera:testnet", id: MANDATE_ID }, quote)).rejects.toBeInstanceOf(MandateRefused);
    expect(signer.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("evm: on success the gate tx precedes signing, and the header echoes the accepted requirements", async () => {
    const service = fakeService(requirementsFor("hedera:testnet", "30000", "0.0.10440535", "0.0.429274"));
    const client = fakeEvmClient();
    const signer = fakeSigner();
    const order: string[] = [];
    client.writeContract.mockImplementation(async () => { order.push("authorize"); return "0xabc"; });
    signer.createPaymentPayload.mockImplementation(async () => { order.push("sign"); return { payload: { transaction: "AAAA" } }; });
    const adapter = new HederaAdapter({ mandateContract: MANDATE, agent: AGENT_EVM, client, signer, fetch: service.fetchImpl });
    const quote = await adapter.quote({ chain: "hedera:testnet", url: "https://feed/price/SOL" });
    const auth = await adapter.authorize({ chain: "hedera:testnet", id: MANDATE_ID }, quote);
    expect(order).toEqual(["authorize", "sign"]);
    expect(auth.gate).toEqual({ kind: "evm-authorize", txHash: "0xabc" });
    // destination handed to the gate is the payTo's EVM form, amount is the quoted amount
    expect(client.readContract.mock.calls[0][0].args).toEqual([MANDATE_ID, AGENT_EVM, hederaLongZeroAddress("0.0.10440535"), 30000n]);
    const decoded = JSON.parse(Buffer.from(auth.paymentHeader!, "base64").toString());
    expect(decoded.accepted).toEqual(quote.requirements);
    expect(decoded.payload).toEqual({ transaction: "AAAA" });
  });

  const solCases: [string, SolanaMandateState | null, bigint][] = [
    ["PerTxLimitExceeded", mandateState({ permissions: [{ key: SHOP_ATA, spendLimit: 0n, perTxLimit: 2_000_000n, spendTotal: 0n }] }), 2_500_000n],
    ["SpendLimitExceeded", mandateState(), 1_000_000n],
    ["DestinationNotAllowed", mandateState({ permissions: [] }), 1n],
    ["Expired", mandateState({ expiry: 1n }), 1n],
    ["NotActive", null, 1n],
    ["NotTheAgent", mandateState({ agent: "11111111111111111111111111111111" }), 1n],
  ];

  for (const [reason, state, amount] of solCases) {
    it(`solana: ${reason} -> MandateRefused before any transaction is built or sent`, async () => {
      const service = fakeService(requirementsFor("solana:devnet", amount.toString(), "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"));
      const client = fakeSolanaClient(state);
      const adapter = new SolanaAdapter({ agent: AGENT_SOL, client, fetch: service.fetchImpl });
      const quote = await adapter.quote({ chain: "solana:devnet", url: "https://feed/price/SOL" });
      const err = await adapter.authorize({ chain: "solana:devnet", id: PDA }, quote).catch((e) => e);
      expect(err).toBeInstanceOf(MandateRefused);
      expect((err as MandateRefused).reason).toBe(reason);
      expect(client.buildExecutePayment).not.toHaveBeenCalled();
      expect(client.send).not.toHaveBeenCalled();
      expect(service.calls.filter((c) => c.headers?.["X-PAYMENT"])).toHaveLength(0);
    });
  }

  it("solana: the local gate mirrors checks.rs order and passes exactly at the cap", () => {
    const m = mandateState();
    expect(() => solanaLocalGate(m, 1_800_000_000n, AGENT_SOL, SHOP_ATA, 500_000n)).not.toThrow();
    expect(() => solanaLocalGate(m, 1_800_000_000n, AGENT_SOL, SHOP_ATA, 500_001n)).toThrow(/SpendLimitExceeded/);
    expect(() => solanaLocalGate(m, 1_800_000_000n, AGENT_SOL, SHOP_ATA, 2_000_001n)).toThrow(/PerTxLimitExceeded/);
  });
});
