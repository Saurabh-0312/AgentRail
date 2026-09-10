# agent

Risk-monitor reference agent (Phase 5). What exists now is its data side:

| Script | What | Model in the loop? |
|---|---|---|
| `yarn workspace @agentrail/agent mcp:demo [keyword]` | Subgraph MCP wiring, deterministic: search -> schema -> query on a published third-party subgraph | no |
| `yarn workspace @agentrail/agent explore "<question>"` | natural-language exploration: a model drives the MCP tools until it can answer | yes, tried in this order: `GEMINI_API_KEY` (default `gemini-flash-latest`), `GROQ_API_KEY` (default `openai/gpt-oss-120b`), `ANTHROPIC_API_KEY` (default `claude-sonnet-5`); `AGENT_MODEL` overrides |

Where natural language is allowed (SPEC §8.7): exploring other people's subgraphs, yes; reading our
own index, no (`@agentrail/query` runs one fixed query); enforcing the mandate, never.

## A recorded run (2026-09-10, Gemini `gemini-flash-latest`; the same question on Groq `openai/gpt-oss-120b` gave the same three markets)

> **Q:** From the most used Aave V2 Ethereum subgraph, list the 3 markets with the highest total
> value locked in USD, with their names and TVL

Tool steps the model chose: `search_subgraphs_by_keyword("Aave v2")` → 8 subgraphs;
`get_deployment_30day_query_counts` on their deployments; `get_top_subgraph_deployments` for the
Aave V2 LendingPool on mainnet (the top deployment by query fees was the same one);
`get_schema_by_subgraph_id` on
`C2zniPn45RnLDGzVeGZCx2Sw3GXrbc9gL4ZfL8B8Em2j` (Messari lending schema 3.1.0);
`execute_query_by_subgraph_id` with `markets(first: 5, orderBy: totalValueLockedUSD, orderDirection: desc) { id name totalValueLockedUSD }`.

> **A:** Using the most-used Aave V2 Ethereum subgraph (`C2zniPn45RnLDGzVeGZCx2Sw3GXrbc9gL4ZfL8B8Em2j`),
> the three markets with the highest TVL are Aave interest-bearing WBTC (≈ 22,759,904 USD), Aave
> interest-bearing USDC (≈ 20,500,323 USD) and Aave interest-bearing WETH (≈ 15,127,410 USD).

Tool results are sized to the provider: Gemini sees up to 120,000 characters per result (whole
schemas), Groq 4,000 (its free tier meters 8k tokens per minute); `AGENT_TOOL_RESULT_CHARS`
overrides. 429s are waited out. A failed tool call is returned to the model as text so it can correct its query.
Gemini's thinking models sign each function call; the signature is echoed back on replay.
