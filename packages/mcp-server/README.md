# @agentrail/mcp-server

An MCP server that lets **any** agent, in any MCP client, read its own AgentRail mandate and ask
*"would this be permitted?"* before it asks the chain. Four tools, all **read-only**. It never
signs, never sends, never holds a key.

This is the reusable-infrastructure half of the project: the risk monitor in `agent/` is one
reference implementation, and this server is how a different agent adopts the same mandate.

| Tool | Answers | Reads |
|---|---|---|
| `get_mandate` | what does this name carry, and what is live on each chain? | ENSv2 (Sepolia) + the mandate on Solana devnet, Hedera testnet, Base Sepolia |
| `check_permission` | would a payment of *amount* to *payee* on *chain* be permitted? | the published allow-list, then the mandate: a local mirror of the Solana program's checks, or `EvmMandate.check` |
| `list_services` | what can an agent discover, and whom may it pay there? | the service names' `rail.*` records |
| `get_history` | what did the mandate do, and what was refused? | the shared index: one fixed query over Subgraph Studio plus the Solana stream |

`check_permission` runs the same two gates the SDK runs before any facilitator is contacted, in
the same order, and returns the same reasons the program would (`NotOnAllowList`,
`PerTxLimitExceeded`, `SpendLimitExceeded`, `DestinationNotAllowed`, …). A refusal at the
allow-list never reads a chain, exactly like the SDK.

## Run it

```bash
yarn install                                  # repo root
yarn workspace @agentrail/mcp-server test     # tool contracts + a real client over stdio
yarn workspace @agentrail/mcp-server start    # stdio server, reads the repo's .env
```

## Paste this into your MCP client

Claude Desktop (`claude_desktop_config.json`), Claude Code (`.mcp.json`), Cursor and most others
use the same shape. Replace the path and the key.

```json
{
  "mcpServers": {
    "agentrail": {
      "command": "node",
      "args": ["/absolute/path/to/AgentRail/packages/mcp-server/src/index.ts"],
      "env": {
        "GRAPH_API_KEY": "<your Subgraph Studio API key, for get_history>",
        "SEPOLIA_RPC_URL": "https://ethereum-sepolia-rpc.publicnode.com",
        "SOLANA_RPC_URL": "https://api.devnet.solana.com",
        "HEDERA_JSON_RPC_URL": "https://testnet.hashio.io/api",
        "BASE_SEPOLIA_RPC_URL": "https://sepolia.base.org"
      }
    }
  }
}
```

Needs Node 22.12+ (the server is TypeScript run directly). Every variable except `GRAPH_API_KEY`
has a public default; without the key, `get_history` explains what is missing and the other three
tools still work.

Optional: `AGENTRAIL_SOLANA_SNAPSHOT=/path/to/web/data/solana-activity.json` makes `get_history`
read the Solana leg from the committed snapshot instead of the reader's local sink, for hosted use.

## Ask it things

- *Read the mandate for databot.agentrail.eth.* → caps, spend, expiry, permitted instructions, live delegate.
- *Can I pay 0.02 USDC to 0.0.10440535 on Hedera?* → `check_permission` with `amount: "20000"`.
- *Can I send 1 USDC to 9xQeW… on Solana?* → refused at the allow-list, no chain read.
- *What was refused?* → `get_history` with `blockedOnly: true`: the error codes, the signatures.

## What it deliberately cannot do

There is no `pay`, `revoke` or `approve` tool. Deciding is the agent's job; enforcing is the
chain's. A model in the enforcement path is one more surface a poisoned input can bend, so this
server answers questions and nothing else.
