# @agentrail/subgraph

Two subgraphs, one schema (`../schema.graphql`), two networks.

| Manifest | Network | Sources | Rows |
|---|---|---|---|
| `subgraph.sepolia.yaml` | `sepolia` | `AgentRailRegistry` (ENSv2 `PermissionedRegistry`), the resolver proxy, the ERC-8004 `IdentityRegistry` | `Mandate` (lifecycle: issued / renewed / unregistered), `MandateRecord` (every `rail.*` text record), `Permission` with `source: "allowlist"` (the published `rail.allowed` mirror), `Service` (the discovery directory: `feed.` / `graph.` / `rogue.agentrail.eth`), `Agent` + `AgentMetadata` (Agent0 / ERC-8004 shape) |
| `subgraph.base.yaml` | `base-sepolia` | `EvmMandate` | `Mandate`, `Permission` with `source: "onchain"`, `Action` for every `SpendAuthorized` / `PaymentExecuted` (`allowed: true` by construction: EVM refusals are views, not transactions) |

> ⚠️ `0x68822ce9…` is `AgentRailRegistry` on Sepolia and `EvmMandate` on Base Sepolia. Each manifest
> loads its own ABI; see `../EVENTS.md`.

## Layout

```
src/shared.ts            namehash step, base58, rail.allowed parser, ids   (pure, unit-tested)
src/sepolia/registry.ts  LabelRegistered / MandateIssued / LabelUnregistered / ExpiryUpdated / …
src/sepolia/resolver.ts  TextChanged -> MandateRecord | Permission (allow-list) | Service
src/sepolia/identity.ts  Registered / MetadataSet / URIUpdated / Transfer -> Agent
src/base/mandate.ts      the six EvmMandate events
tests/*.test.ts          matchstick-as: every handler, every branch
```

The join key is derived in the mapping: `ensNode = keccak256(namehash("agentrail.eth") ‖ labelHash)`,
and the test asserts it equals the live `databot.agentrail.eth` node.

## Commands

```
yarn codegen           # both manifests
yarn build             # both manifests
yarn test              # matchstick (needs the matchstick binary: Linux/macOS, or `graph test -d` with Docker; CI runs it)
yarn deploy:sepolia    # Studio slug `agentrail`
yarn deploy:base       # Studio slug `agentrail-base`
```

Deploy needs `graph auth <Studio deploy key>` once. Deployments stay in Studio (queried with an API
key); nothing is published to the network.

## Live

- Sepolia: `https://api.studio.thegraph.com/query/120234/agentrail/v0.1.0`
- Base Sepolia: `https://api.studio.thegraph.com/query/120234/agentrail-base/v0.1.0`
