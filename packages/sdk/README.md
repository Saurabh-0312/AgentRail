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

## Tests

`yarn test`: every tail satisfies the same contract; every refusal reason on every tail is thrown
before a transaction is built, a payment is signed, or a paid request is sent.
