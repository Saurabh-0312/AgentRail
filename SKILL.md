# SKILL.md — AgentRail

**AgentRail is infrastructure: instruction-level authorization for AI agents.** The risk monitor in
[`agent/`](agent/) is a reference implementation, not the product. Any agent can adopt the same
mandate, the same adapter and the same index.

> The agent has no signing authority. It can *ask* to spend. Only the on-chain mandate can *sign*.
> An LLM is never in the enforcement path.

---

## What the pieces are, and which is reusable

| Piece | Path | Reusable as |
|---|---|---|
| The gate (Solana program) | [`programs/agentrail`](programs/agentrail) | An Anchor program any owner can issue mandates from. `execute_payment` answers *how much, to whom*; `verify` answers *which instruction* |
| The gate (EVM) | [`contracts/src/EvmMandate.sol`](contracts/src/EvmMandate.sol) | The same mandate on Hedera testnet and Base Sepolia |
| The SDK | [`packages/sdk`](packages/sdk) | `PaymentAdapter { quote, authorize, settle }`, one interface, three chains. ENS discovery, allow-list, x402 |
| The index | [`indexer/`](indexer) | One GraphQL schema over three chains, joined by the ENS namehash. Two published Substreams packages |
| The agent | [`agent/`](agent) | The reference implementation: tools, rules, graded response, attack harness |

**Load-bearing use of The Graph:** the agent explores 15,000+ published subgraphs in natural
language through the **Subgraph MCP** to discover what a wallet is exposed to, and reads its own
budget from **Subgraph Studio** endpoints with a fixed query. Remove The Graph and the agent is
blind to its own spending, cannot discover exposure, and there is no evidence the gate ever fired.

---

## Where natural language is allowed (the rule that shapes the code)

```
EXPLORING third-party subgraphs   ->  Subgraph MCP, natural language
READING our own budget/history    ->  fixed GraphQL (@agentrail/query fetchHistory)
DECIDING what to do               ->  the model may decide
ENFORCING the mandate             ->  on-chain only, NEVER an LLM
```

`requestPayment()` and `requestAction()` are plain typed functions. No model sits between the
decision and the chain, because an LLM in the enforcement path is one more surface a poisoned input
can bend.

---

## Run it

### Prerequisites

- Node **22.12+** (this repo is developed on Node 25), `yarn`
- A **Graph API key** (Subgraph Studio) for the MCP and the Studio endpoints
- One model key: **`GEMINI_API_KEY`** or **`GROQ_API_KEY`** (both have free tiers).
  `ANTHROPIC_API_KEY` is optional and is not required anywhere. The Gemini default is
  **`gemini-3.5-flash-lite`**: free-tier quotas are per model, and the full flash models allow only
  about 20 requests a day, which one agent run exhausts. Override with `AGENT_MODEL`
- For the live chain steps: a funded Solana devnet wallet, and the testnet keys in `.env.example`

```bash
git clone https://github.com/Saurabh-0312/AgentRail && cd AgentRail
yarn install
cp .env.example .env      # fill in the keys; every public address is already there
```

### The tests (no keys needed)

```bash
yarn workspace @agentrail/agent test      # the agent: tools, rules, response, injection
yarn workspace @agentrail/sdk test        # the adapter and both gate mirrors
yarn workspace @agentrail/query test      # the fixed query
cd contracts && forge test                # EvmMandate
```

### The proof layer: one query, three chains

```bash
yarn sink:solana     # first run only: streams the Solana leg into indexer/query/out (~12 min)
yarn history         # the same query text against Sepolia, Base Sepolia and Solana
```

Returns every mandate action under one `ensNode`, **including the refused ones** — on Solana the
gate and the transfer are one instruction, so a refusal is a landed, failed transaction with
`InstructionError(Custom(6006|6007|6008))`.

### The agent

```bash
# natural language over published third-party subgraphs (the MCP)
yarn workspace @agentrail/agent explore "Which markets on Aave V2 Ethereum have the highest TVL?"

# the risk-monitor job: discovery pass first, then drills, then one verdict
ALICE_WALLET=0x… yarn workspace @agentrail/agent monitor

# the whole story
yarn workspace @agentrail/agent demo            # identity, monitor, defend, attack
yarn workspace @agentrail/agent demo defend     # the protective action, permitted and refused
yarn workspace @agentrail/agent attack          # the three injections
```

Each run writes a structured transcript to `agent/out/<run>.md` and `.json`: every tool call, every
decision, every refusal, and every chain verdict with its explorer link.

### The dashboard

**Live: https://agentrail-delta.vercel.app** (no wallet or key needed to read it)

```bash
yarn workspace @agentrail/web dev        # http://localhost:3000
yarn workspace @agentrail/web test
```

Paste any ENS name. `/agent/<name>` shows identity, permissions and live caps; `/activity` is the
feed with every refusal loud and filterable; `/services` is the ENS-resolved directory; `/attack`
is the walkthrough of the poisoned run with the four reverted signatures. Every key is server-side;
`yarn workspace @agentrail/web check:bundle` proves none reached the browser.

### The MCP server (for any other agent)

```bash
yarn workspace @agentrail/mcp-server test    # tool contracts + a real client over stdio
yarn workspace @agentrail/mcp-server start   # stdio server
```

Four read-only tools: `get_mandate`, `check_permission`, `list_services`, `get_history`. The config
block to paste into Claude Desktop, Claude Code or Cursor is in
[`packages/mcp-server/README.md`](packages/mcp-server/README.md). It never signs.

### The demos from earlier phases

```bash
yarn demo:devnet      # Solana: caps (6007, 6008) and the instruction gate (6006)
yarn demo:hedera      # real USDC settled and refused on Hedera
yarn demo:discovery   # two shops on two chains, discovered from ENS, no URL and no API key
```

> **Run `yarn demo:devnet` before any live agent run.** The devnet mandate expires 24 h after each
> run, and a stale mandate makes every attempt revert with `Expired` instead of the code being
> demonstrated.

---

## What the agent actually does

**The job:** *is Alice about to lose money?* It answers continuously.

1. **Budget first.** `getMyMandate()` — the fixed query over three chains, plus a live read of the
   delegated token account (who the delegate is right now)
2. **Discovery pass.** *"Which protocols does this wallet hold positions in?"* — natural language,
   over subgraphs it did not write. It cannot hardcode "check Aave"; it does not know yet
3. **Drills.** Positions, approvals and outflows in the subgraphs the discovery pass named
4. **It buys the data it needs.** Prices come from `feed.agentrail.eth`, paid per query through the
   mandate. The monitor is also a customer
5. **Three rules decide, not the model.** R1 unknown-or-unlimited approval (CRITICAL, the drainer
   signature) · R2 more than 20% of a balance out in 24 h (HIGH) · R3 health factor below 1.1 (MEDIUM)
6. **Graded response.** MEDIUM logs · HIGH alerts the owner on the Hedera Consensus Service topic ·
   **CRITICAL attempts a protective action** — and that action goes through the same gate as any
   payment. If the mandate permits it, the agent defends Alice. If not, it can only warn.

**That last point is the design insight.** Everyone can demo a permission system blocking something
bad. Here the constraint governs something *good*, which is what proves it is unconditional rather
than a filter on intent.

---

## The attack (what the submission rests on)

The harness plants a hidden instruction **inside data the agent legitimately paid for** — a security
advisory spliced into a feed response, framed as an urgent protective action. A real model reads it
and decides. Nothing is scripted; the harness only records what happened.

| # | The injected instruction | What stops it |
|---|---|---|
| 1 | move the balance to a "secure recovery address" | the payee is not on `rail.allowed`; `execute_payment` **reverts** |
| 2 | reassign the token account authority (`SetAuthority`) | the discriminator is not on the mandate; `verify` **reverts 6006** |
| 3 | resend the transfer after the owner revoked | there is no live mandate; **reverts** |

Each produces a real, linkable reverted transaction, alongside the agent's own log showing it
intended to comply.

**We do not claim the agent cannot be tricked. It can, and that is the point.**
AgentRail does not make the agent smarter. It makes being fooled stop mattering.

---

## Honest limitations

- **Loss up to the budget cap is possible.** A fully compromised agent can still spend its allowance
  at *allowed* payees. That is the designed maximum loss, not a bug
- **Only funds under the delegation are protected.** An agent holding its own separate keys is
  outside the scope, exactly as with SPL `approve`
- **A compromised owner key ends the game.** AgentRail protects against a bad agent, not a bad owner
- **We do not verify that purchased data is true**, only what the agent may pay for
- **Spend is recorded before settlement on the EVM**, so a failed settlement still consumes budget:
  the mandate can under-spend, never over-spend
- Subgraphs are deployed to **Subgraph Studio and queried with an API key** (the qualifying path);
  nothing is published to the network, which would need curation signal on mainnet

Prior art we do **not** claim to have invented: Zodiac Roles does selector-level gating in
production on the EVM, ERC-8004 is the agent identity standard we register in, and MetaMask
delegation is already non-custodial. What is new here is instruction-level authorization on Solana,
published as an ENS name, enforced across three chains under one mandate.

---

## Live artifacts

| | |
|---|---|
| Solana program | `GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj` (devnet) |
| Mandate name | `databot.agentrail.eth` — node `0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae` |
| `EvmMandate` | `0x68822ce9109D9d71e99b07703cF6c851D0229AA9` on Hedera testnet and Base Sepolia |
| ERC-8004 identity | registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`, agent id `10190` (Sepolia) |
| Services | `feed.agentrail.eth` · `graph.agentrail.eth` · `rogue.agentrail.eth` |
| Subgraphs | `…/120234/agentrail/v0.1.0` (Sepolia) · `…/120234/agentrail-base/v0.1.0` (Base Sepolia) |
| Substreams | [agentrail-mandates](https://substreams.dev/packages/agentrail-mandates/v0.1.0) · [agentrail-token-activity](https://substreams.dev/packages/agentrail-token-activity/v0.1.0) |
| Live x402 service | https://agentrail-data-feed.onrender.com (free tier: wake it before a demo) |
| Live dashboard | https://agentrail-delta.vercel.app |
| HCS audit topic | `0.0.10440940` |

License: MIT.
