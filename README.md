# AgentRail

> **Agents go off the rails. AgentRail is the rails.**

Instruction-level authorization for AI agents. A permission mandate is published as a public ENS name and enforced on-chain — so an agent physically cannot do what it was not authorized to do.

**ETHOnline 2026** · Classic (From Scratch) track

---

## The problem

Solana can verify **who** signed a transaction. It cannot enforce **what** that signer was permitted to do.

Every program exposes many instructions, and they are not equally safe:

```
Jupiter
  ├─ swap()            ← you want the agent to call this
  ├─ setAuthority()    ← this hands over control
  └─ withdrawAll()     ← this empties you
```

Today, authorizing the program authorizes **every instruction in it**. Squads' `SpendingLimit` stores `mint · amount · period · members · destinations` — no program, no instruction. It cannot express *"allow `swap`, deny `set_authority`, on the same program."*

Your only options are all-or-nothing (hand over the private key), custodial (a vault or a company's policy server), or amount-only (`SPL approve`).

## The approach

| Layer | Role |
|---|---|
| **ENS (Sepolia)** | The mandate — an expiring, revocable, **non-transferable** subname carrying the permission set. Also the service directory the agent discovers providers through |
| **Solana** | The gate — holds the SPL delegate authority. The agent can *ask*; only AgentRail can *sign* |
| **Hedera** | Real x402-metered services. Money actually moves, and actually gets refused |
| **The Graph** | The audit trail and the agent's own budget awareness — one shared schema across chains |

The user's tokens never leave their wallet. They delegate a bounded budget to AgentRail via SPL `approve`; AgentRail releases funds only when the mandate permits it.

> `SPL approve` says **how much**. AgentRail says **what for**.

## Threat model

AgentRail does not try to make an agent harder to fool. It makes being fooled stop mattering.

| Attack | Outcome |
|---|---|
| Prompt injection / poisoned data | destination not on the allowed list → **blocked** |
| **Agent's private key fully stolen** | the key was never a spending authority → **blocked** |
| A service turns malicious and overcharges | exceeds per-transaction cap → **blocked** |
| Wrong instruction on an allowed program | discriminator not permitted → **blocked** |
| Replay after revocation | `active` checked at execution → **blocked** |
| Slow drain via permitted payments | **capped** at the mandate budget |

### Known limits

- Loss is bounded by the mandate budget, not eliminated. A fully compromised agent can still spend its allowance at permitted destinations
- Funds outside the delegation are not protected — the same trust model as `SPL approve`
- This protects against a compromised **agent**, not a compromised **owner**
- AgentRail governs what an agent may pay for, not whether the data it received is accurate

## Reference implementation

A theft and portfolio risk monitor. It purchases market data and on-chain position data, reasons over both to detect abnormal outflows and unauthorized approvals, and raises graded alerts. When a critical risk is detected it attempts a protective action — which the mandate governs exactly like any other action.

## Status

Under active development for ETHOnline 2026.

## License

MIT
