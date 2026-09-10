# AgentRail

> **Agents go off the rails. AgentRail is the rails.**

Instruction-level authorization for AI agents. A permission mandate is published as a public ENS name and enforced on-chain — so an agent physically cannot do what it was not authorized to do.

**ETHOnline 2026**

---

## The problem

A blockchain can verify **who** signed a transaction. It cannot enforce **what** that signer was permitted to do.

Authorizing an autonomous agent today is all-or-nothing: hand over a private key, migrate assets into a custodial vault, or trust a company's policy server. None of them let you say *"you may do this, but not that"* and have the chain enforce it.

## What we're building

A mandate that states exactly what an agent may do — which programs, which instructions, how much, and until when. It is published where anyone can read it, and enforced where the money is.

The user's tokens never leave their wallet. The agent can *ask* to spend. Only AgentRail can *sign*.

Services get ENS names too. The agent starts with a name, resolves what exists to buy (`rail.endpoint`, `rail.chain`, `rail.price`), checks it against its own mandate, and pays through x402. No URL and no API key appear anywhere in the demo.

Built with **ENS**, **Solana**, **Hedera**, and **The Graph**.

## The proof layer

Everything a mandate did, on every chain it exists on, under one GraphQL schema
([`indexer/schema.graphql`](indexer/schema.graphql)), joined by the ENS namehash the owner wrote into
each chain. Sepolia and Base Sepolia are subgraphs in Subgraph Studio; Solana devnet is a
Substreams package streamed from a Graph provider, decoded from instruction data and transaction
meta so that **the refused attempts are rows too** (`allowed: false`, `blockReason: OVER_BUDGET`).

```graphql
{ mandates(where: { ensNode: "0x320d…" }) { chain actions { allowed blockReason amount } } }
```

One query, one name, three chains. See [`indexer/`](indexer/).

## The agent

AgentRail is the infrastructure. The **theft and portfolio risk monitor** in [`agent/`](agent/) is
its reference implementation: it asks *"is Alice about to lose money?"*, and it answers by
discovering which protocols a wallet is exposed to across published subgraphs in natural language,
drilling into them, buying the prices it needs through its own mandate, and correlating one verdict.

Severity decides what it may attempt. MEDIUM is logged, HIGH alerts the owner, and **CRITICAL
attempts a protective action — which the mandate governs exactly like any payment.** If the mandate
permits it, the agent defends her. If not, it can only warn. The constraint is unconditional, not a
filter on intent.

Then it is attacked. A hidden instruction is planted inside data the agent legitimately paid for, a
real model reads it and sincerely tries to comply, and the chain refuses — an unlisted destination,
a forbidden instruction, and a revoked mandate, each a real reverted transaction.

**We do not claim the agent cannot be tricked. It can, and that is the point.** AgentRail does not
make the agent smarter; it makes being fooled stop mattering.

Judges: [`SKILL.md`](SKILL.md) is the one-page guide to running all of it.

## Limitations

- **Scope of enforcement.** AgentRail enforces for funds under its delegation (SPL `approve` on Solana, ERC-20 allowance on the EVM). It does not stop an agent that independently holds its own keys to other funds — the same trust model as SPL `approve`.
- **Spend is recorded before settlement.** On the EVM, `EvmMandate.authorize` records the spend when the gate passes, before the x402 facilitator settles. A settlement that later fails still consumes budget. This is the conservative choice: the mandate can under-spend, never over-spend.
- **Single asset per mandate.** Caps are in base units of the token the mandate is delegated on; a mandate does not convert between assets.

## Status

Under active development.

## License

MIT
