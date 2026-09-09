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

Built with **ENS**, **Solana**, **Hedera**, and **The Graph**.

## Limitations

- **Scope of enforcement.** AgentRail enforces for funds under its delegation (SPL `approve` on Solana, ERC-20 allowance on the EVM). It does not stop an agent that independently holds its own keys to other funds — the same trust model as SPL `approve`.
- **Spend is recorded before settlement.** On the EVM, `EvmMandate.authorize` records the spend when the gate passes, before the x402 facilitator settles. A settlement that later fails still consumes budget. This is the conservative choice: the mandate can under-spend, never over-spend.
- **Single asset per mandate.** Caps are in base units of the token the mandate is delegated on; a mandate does not convert between assets.

## Status

Under active development.

## License

MIT
