# indexer — one schema, three chains

The proof layer. Everything an AgentRail mandate did, on every chain it exists on, under one
GraphQL schema, joined by the ENS namehash the owner wrote into each chain.

```
Sepolia      AgentRailRegistry + resolver + ERC-8004   ──▶  subgraph  (Subgraph Studio)  ─┐
Base Sepolia EvmMandate                                 ──▶  subgraph  (Subgraph Studio)  ─┼─▶  schema.graphql
Solana devnet AgentRail program (no events)            ──▶  Substreams (Graph provider)  ─┘        │
                                                                                                   ▼
                                    { mandates(where: { ensNode: "0x320d…" }) { chain actions { allowed blockReason amount } } }
```

| Directory | What | Source |
|---|---|---|
| [`schema.graphql`](schema.graphql) | the shared schema: `Mandate` / `Permission` / `Action` (SPEC §8.4) on an ERC-8004 `Agent` base (Agent0 shape) | – |
| [`EVENTS.md`](EVENTS.md) | the event inventory per chain, confirmed against live logs, and the rules learned | – |
| [`subgraph/`](subgraph) | two manifests, one schema: `subgraph.sepolia.yaml` (mandate lifecycle, `rail.*` records, allow-list, ERC-8004 identity) and `subgraph.base.yaml` (EvmMandate permissions and every authorized spend) | Subgraph Studio, queried with an API key |
| [`substreams/`](substreams) | Rust package `agentrail_mandates` ([published](https://substreams.dev/packages/agentrail-mandates/v0.1.0)): every `execute_payment` / `verify`, **successes and reverts**, decoded from instruction data and transaction meta | streamed from a Graph provider (`devnet.sol.streamingfast.io`, Graph Market token) |
| [`substreams-token-activity/`](substreams-token-activity) | the Substreams SKILLs one-prompt pipeline: SPL Token activity on the owner's delegated USDC account, every transfer attributed to its signer ([published](https://substreams.dev/packages/agentrail-token-activity/v0.1.0)) | streamed from the same provider |
| [`query/`](query) | the reader: one fixed query run verbatim on every source, rows concatenated; a GraphQL endpoint over the shared schema; the Solana sink | – |

## Why the join works

`ensNode` is written by the owner into three places: the ENS registry (the name itself), the
Solana mandate account (offset 80, passed to `create_mandate`), and the EVM mandate
(`MandateCreated.ensNode`). Same 32 bytes everywhere, so `Mandate.id = <ensNode>:<chain>` and one
`where: { ensNode }` returns rows from all three.

## What became easier

With the shared schema the reader is one query string and `[...sepolia, ...base, ...solana]`.
Without it: three differently shaped queries (ENS labels and text records; EVM events keyed by a
`bytes32 mandateId`; Solana instruction bytes keyed by a PDA), three field-mapping layers, and a
client-side join on three different id formats. See `query/COMPARISON.md`.

## Where the blocked attempts come from

Only Solana can show a refusal as a row: the gate and the transfer are one instruction, so a
refusal is a landed, failed transaction with its error code in the meta. `EvmMandate.check` is a
view the SDK asks first, so an EVM refusal never becomes a transaction (0 requests, no gas). The
Substreams package keeps every failed transaction and maps 6006 → `NOT_PERMITTED`, 6007 / 6008 →
`OVER_BUDGET`, 6001 → `EXPIRED`, 6000 → `REVOKED`.

## Running

```
# subgraphs (Sepolia + Base Sepolia): codegen, build, matchstick, deploy to Studio
yarn workspace @agentrail/subgraph codegen && yarn workspace @agentrail/subgraph build
yarn workspace @agentrail/subgraph test            # matchstick: Linux/macOS, or CI
yarn workspace @agentrail/subgraph deploy:sepolia  # after `graph auth <deploy key>`
yarn workspace @agentrail/subgraph deploy:base

# substreams (Solana devnet)
cd indexer/substreams && cargo test && cargo build --target wasm32-unknown-unknown --release && substreams pack substreams.yaml

# the Solana leg of the reader: stream from the provider into query/out (resumable)
yarn sink:solana

# one query, three chains
yarn history                                       # prints the merged table for RAIL_NODE
yarn workspace @agentrail/query serve              # POST http://localhost:4030/graphql
```

Studio deployments are **not published to the network**: Studio with an API key is the qualifying
path, and publishing needs curation signal on Arbitrum mainnet. The Subgraph MCP is used for
exploring other people's published subgraphs, never ours (SPEC §8.7).
