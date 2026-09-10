# @agentrail/sdk

The payment adapter (SPEC §8.6): **one interface, three tails**.

```ts
interface PaymentAdapter {
  quote(service):              Quote          // what it costs, in what, on which chain
  authorize(mandate, quote):   Authorization  // THE GATE — the mandate decides first
  settle(authorization):       Settlement     // the facilitator, or the chain itself, finishes
}
```

`authorize` runs the mandate check **before any facilitator or service is asked to settle**. If the
mandate refuses, `MandateRefused` is thrown with the same error name the chain would have used
(`PerTxLimitExceeded`, `SpendLimitExceeded`, `DestinationNotAllowed`, `Expired`, `NotActive`,
`NotTheAgent`) and nothing is signed or sent. The tests prove it with injected transports.

| Tail | Chain id (`rail.chain`) | Gate | Rail |
|---|---|---|---|
| `HederaAdapter` | `hedera:testnet` | `EvmMandate.check` → `EvmMandate.authorize` on Hedera | x402 exact, HTS USDC or HBAR, settled by the service through Blocky402 |
| `BaseAdapter` | `eip155:84532` | same contract on Base Sepolia | x402 exact, EIP-3009 USDC, settled by the service's facilitator |
| `SolanaAdapter` | `solana:devnet` | local mirror of `checks.rs` on the mandate PDA | `execute_payment`: the mandate PDA signs as SPL delegate. Gate and settlement are one atomic instruction; no facilitator is needed |

Adapters are selected by chain id through `AdapterRegistry`, the string ENS `rail.chain` will carry.
No service URL lives in this package; a `ServiceRef` is discovered elsewhere and handed in.

## Wiring

```ts
import { createEvmClients, hederaTestnet } from "@agentrail/sdk/src/evm/clients.ts";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

const evm = createEvmClients(hederaTestnet, HEDERA_JSON_RPC_URL, HEDERA_PRIVATE_KEY);
const signer = new ExactHederaScheme(createClientHederaSigner(HEDERA_ACCOUNT_ID, PrivateKey.fromStringECDSA(HEDERA_PRIVATE_KEY), { network: "hedera:testnet" }));
const hedera = new HederaAdapter({ mandateContract: EVM_MANDATE_HEDERA, agent: evm.account.address, client: evm.gate, signer });

const quote = await hedera.quote({ chain: "hedera:testnet", url: "https://feed/price/SOL,HBAR" });
const auth = await hedera.authorize({ chain: "hedera:testnet", id: mandateId }, quote); // throws MandateRefused
const done = await hedera.settle(auth);                                                   // Mirror Node is the record
```

On Hedera the same ECDSA key is the mandate's agent and the x402 payer, so one identity both asks
and pays. `createAnchorGateClient` gives the Solana tail a real client over the deployed program.

## Discovery (Phase 3)

The agent starts with an ENS name and nothing else:

```ts
import { discoverService, parseAllowed, assertAllowed, AdapterRegistry } from "@agentrail/sdk";
import { sepoliaEnsReader } from "@agentrail/sdk/src/ens.ts";

const readText = sepoliaEnsReader(SEPOLIA_RPC_URL);              // ENSv2 UniversalResolver, Sepolia
const allowed  = parseAllowed(await readText("databot.agentrail.eth", "rail.allowed"), "databot.agentrail.eth");
const service  = await discoverService("feed.agentrail.eth", readText); // rail.endpoint / chain / price / token / scheme
const adapter  = registry.select(service.chain);                  // rail.chain picks the tail
const quote    = await adapter.quote(service);
assertAllowed(allowed, service, quote.payTo);                     // discovery is not authorization
const auth     = await adapter.authorize(mandate, quote);         // the mandate decides
const done     = await adapter.settle(auth);
```

Service names carry five records (`rail.endpoint`, `rail.chain`, `rail.price`, `rail.token`,
`rail.scheme`); a missing or malformed record throws `DiscoveryError`, never a default URL. A
service that resolves correctly but whose payee is not in the agent's `rail.allowed` record is
refused with `NotOnAllowList` before the mandate, the facilitator, or any signature is touched.
The only address in the package is ENS's own UniversalResolver.

## Field notes (what is actually live)

- **The Graph testnet gateway.** The documented host `testnet.gateway.thegraph.com` has no DNS
  record; the live one is `https://gateway.testnet.thegraph.com/api/x402/subgraphs/id/{id}`
  (mainnet: `gateway.thegraph.com`, `eip155:8453`). Its 402 arrives in the `PAYMENT-REQUIRED`
  header with an empty body, 42 USDC units per query on `eip155:84532`, and the payment must be
  sent as `Payment-Signature`; `fetchQuote` reads body or header and `payAndFetch` sends both
  header spellings. Its facilitator intermittently fails to land a settlement
  (`invalid_exact_evm_transaction_failed`); because `EvmMandate.authorize` records spend first,
  a retried purchase consumes budget twice. Size caps accordingly.
- **Hedera mirror lag is a rule.** `eth_call` / `eth_estimateGas` on `testnet.hashio.io` can be
  answered by a node a minute or more behind consensus. Anything that acts on Hedera state must
  decide on receipts, never branch on a read: `issueEvmMandate` sends with an explicit gas limit,
  treats a reverted `createMandate` receipt as "a mandate exists", revokes, and retries once.

## Tests

`yarn test`: every tail satisfies the same contract; every refusal reason on every tail is thrown
before a transaction is built, a payment is signed, or a paid request is sent.

## The instruction gate, mirrored (Phase 5)

`verify` is the novel half of the program (SPEC §8.1.1): it answers *which instruction*, not *how
much*. The SDK mirrors it the way it already mirrored `execute_payment`:

- `solanaLocalVerifyGate(state, now, agent, sibling, declaredAmount)` — the same order as
  `verify.rs`: live → agent → program → discriminator → caps. A forbidden instruction never leaves
  the process; the chain runs the same checks again, atomically
- `discriminatorAllowed` compares only the permission's width (1 / 4 / 8), like `checks.rs`;
  `splTokenAmount` parses the amount out of `[tag, u64 LE, …]` like `verify.rs`
- `buildVerifiedInstruction(mandate, sibling, declaredAmount)` — `[verify(1, declared), sibling]`
  in one transaction, signed by the agent and the fee payer
- `land(signed)` — submits and **reports** the chain's verdict (`{ signature, failed, errorCode,
  errorName }`) instead of throwing, so a refusal is recorded with its signature. `send` is `land`
  plus a throw
- `SPL_TOKEN_TAG`: the 1-byte discriminators a mandate can list

`readMandate` now also returns each permission's `discriminators` and `discriminatorSize`, and the
EVM ABI carries `getDestinations`.

## Who uses the SDK

| Consumer | How |
|---|---|
| [`agent/`](../../agent) | the reference agent: `discoverService`, `assertAllowed`, the adapters, the verify mirror |
| [`web/`](../../web) | the dashboard's route handlers: `sepoliaEnsReader`, `discoverService`, `parseAllowed`, the ABI, the Anchor client (read-only) |
| [`packages/mcp-server`](../mcp-server) | four read-only MCP tools over the same functions, so any agent can ask "what am I allowed to do?" |

Deep imports are allowed (`@agentrail/sdk/src/ens.ts`, `…/evm/clients.ts`, `…/solana/anchorClient.ts`)
so a consumer can take the light piece it needs without the chain SDKs behind the rest.
