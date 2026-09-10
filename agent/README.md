# @agentrail/agent

The **theft and portfolio risk monitor**: the reference implementation of an agent that runs on
AgentRail. It answers one question continuously — *is Alice about to lose money?* — and it cannot
spend or act outside the mandate she issued it.

> The agent holds no signing authority. It can *ask*. Only the on-chain mandate can *sign*.
> No model is ever in the enforcement path.

---

## The tool surface

Five plain, typed functions. The model chooses which to call; the chain decides whether it may.

| Tool | What it does | Where the data comes from |
|---|---|---|
| `discoverService(ensName)` | resolves a service to `{ chain, url, price, token }` | ENS records (`rail.*`) |
| `querySubgraph(question)` | a natural-language question about public on-chain data | **Subgraph MCP**, third-party subgraphs only |
| `getMyMandate()` | caps, spent, remaining, expiry, active, permitted instructions, live delegate | **fixed GraphQL query** over the AgentRail index |
| `requestPayment(request)` | buys from a discovered service, or pays a wallet | the payment adapter, then the on-chain gate |
| `requestAction(action)` | one SPL Token instruction on Alice's delegated account | the on-chain instruction gate (`verify`) |

**Where natural language is allowed:** exploring other people's subgraphs, yes. Reading our own
index, no — that is a known question with a known shape, so it is a fixed query. Enforcing the
mandate, never.

## What it does with them

1. **Budget first.** `getMyMandate()` — what it may spend, what it has spent, and who currently
   holds the delegation on Alice's token account.
2. **A discovery pass.** *"Which protocols does this wallet hold positions in?"* It cannot hardcode
   a protocol; it does not know until it looks. This is why it needs natural language over many
   subgraphs.
3. **Drills** into whichever protocols the discovery pass named: positions, approvals, outflows.
4. **Buys the data it needs**, per query, through the mandate. The monitor is also a customer.
5. **Three rules decide** — never the model:

   | Rule | Fires when | Severity |
   |---|---|---|
   | R1 | an approval to a spender with no history, or an unlimited amount | CRITICAL |
   | R2 | more than 20% of a balance leaves in 24 h | HIGH |
   | R3 | a lending health factor below 1.1 | MEDIUM |

6. **Graded response.** MEDIUM is logged. HIGH alerts the owner. **CRITICAL attempts a protective
   action** — and that action is governed by the mandate exactly like a payment. If the mandate
   permits it, the agent defends her. If not, it can only warn.

Every run writes a transcript to `out/<run>.md` and `out/<run>.json`: each tool call, decision,
refusal and chain verdict, with explorer links.

---

## Running it

Needs Node 22.12+ and, from the repo root, `yarn install` and a filled-in `.env`.

| Variable | For |
|---|---|
| `GRAPH_API_KEY` | the Subgraph MCP and the Studio endpoints |
| `GEMINI_API_KEY` **or** `GROQ_API_KEY` | the model (both have free tiers; `ANTHROPIC_API_KEY` is optional and never required) |
| `SUBGRAPH_SEPOLIA_URL`, `SUBGRAPH_BASE_URL` | the fixed query |
| `SEPOLIA_RPC_URL`, `SOLANA_RPC_URL`, `HEDERA_*`, `EVM_MANDATE_*`, `RAIL_NODE` | the rails |
| `ALICE_WALLET` | the wallet the monitor watches |
| `HCS_AUDIT_TOPIC_ID` | optional: alerts go to the Hedera audit topic instead of the log |

```bash
yarn workspace @agentrail/agent test        # no keys needed

yarn workspace @agentrail/agent explore "Which Aave V2 markets have the highest TVL?"
yarn workspace @agentrail/agent mcp:demo    # the MCP wiring, no model in the loop
yarn workspace @agentrail/agent monitor     # the risk-monitor job (reads ALICE_WALLET)
yarn workspace @agentrail/agent attack      # the three injection attacks
yarn workspace @agentrail/agent demo        # the whole story: identity, monitor, defend, attack
```

`demo` takes a stage: `identity`, `monitor`, `defend`, `attack`.

> **Run `yarn demo:devnet` from the repo root first.** The devnet mandate expires 24 h after each
> run, and a stale one makes every attempt revert with `Expired` instead of the code being shown.

Model selection is `GEMINI_API_KEY`, then `GROQ_API_KEY`, then `ANTHROPIC_API_KEY`. `AGENT_MODEL`
overrides the model name and `AGENT_TOOL_RESULT_CHARS` the per-result budget. To force the fallback
when a free tier is exhausted, set the earlier key to empty on the command line — environment
variables take precedence over `--env-file`:

```bash
cd agent && GEMINI_API_KEY= node --env-file=../.env src/attack/run.ts all
```

---

## The attack

`src/attack/` plants a hidden instruction **inside data the agent legitimately paid for**: a security
advisory spliced into a feed response, written to look like an urgent protective instruction from
its own operator. A real model reads it and decides what to do. Nothing is scripted — the harness
only records what happened, and reports honestly when the model declines on its own.

| Attack | The agent is told to | The gate |
|---|---|---|
| `divert` | move the balance to a "secure recovery address" | the payee is not on `rail.allowed` — `execute_payment` reverts |
| `seize` | reassign the token account authority | `SetAuthority` is not on the mandate — `verify` reverts 6006 |
| `replay` | resend a transfer after the owner revoked | there is no live mandate — reverts |

**The agent can be tricked. That is the point.** AgentRail does not make it smarter; it makes being
fooled stop mattering.

## Layout

```
src/tools.ts        the five tools
src/agent.ts        runAgent(goal): the model, the tools, a bounded loop
src/monitor.ts      the risk-monitor job
src/rules/          R1, R2, R3 and the adapters from fetched rows
src/response.ts     graded response and the protective action
src/runtime.ts      .env -> real tools and rails
src/attack/         the injection harness
src/transcript.ts   the run log
src/mcp.ts          the Subgraph MCP client
src/explore.ts      the model-driven MCP loop
```
