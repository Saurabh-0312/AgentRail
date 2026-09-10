# @agentrail/web

The dashboard. Paste an agent's ENS name and see what it may do: its identity, its permissions
and live caps on every chain, every action it took and every one it was refused, the services it
can discover, and how a real model was tricked and stopped.

Every key stays on the server. The browser only ever calls this app's own API.

## Pages

| Route | What a judge sees |
|---|---|
| `/` | one input, three examples, a live status strip with a real dot per chain |
| `/agent/<name>` | identity · non-transferable / expiring / revocable with proof links · permissions per chain with live spend bars · the published rules · raw records · owner actions |
| `/activity` | one feed across three chains; **blocked rows loud**, filterable, every tx linked |
| `/services` | the three services resolved from ENS, the rogue one marked from its own payee |
| `/attack` | the poisoned advisory, the model's words, four reverted signatures, the protective sequence |

## How it is hosted

| Data | Where it comes from |
|---|---|
| ENS records, live mandates, status | route handlers under `app/api/`, reading the chains with server-side RPC URLs |
| Sepolia + Base history | the two Subgraph Studio endpoints, queried server-side with `GRAPH_API_KEY` |
| Solana history | `data/solana-activity.json`, a **committed snapshot** of the Substreams stream; its `syncedAt` is shown in the UI |

The snapshot exists because a deployed app cannot read the reader's local sink (`indexer/query/out`,
gitignored). Refresh it after `yarn sink:solana`:

```bash
yarn workspace @agentrail/web snapshot:solana
```

## Run

```bash
yarn install                                   # repo root
yarn workspace @agentrail/web dev              # http://localhost:3000, reads the repo's .env
yarn workspace @agentrail/web test             # routes, feed rendering, owner gating, secret isolation
yarn workspace @agentrail/web build && yarn workspace @agentrail/web check:bundle
```

`check:bundle` scans `.next/static` (what browsers download) for every secret value in the root
`.env` and every server-only variable name, and fails the build if one appears.

Server environment (Vercel project settings, or the repo `.env` locally): `GRAPH_API_KEY`,
`SEPOLIA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `HEDERA_JSON_RPC_URL`, `SOLANA_RPC_URL`,
`SUBGRAPH_SEPOLIA_URL`, `SUBGRAPH_BASE_URL`. Nothing is prefixed `NEXT_PUBLIC_`.

## Deploy

**Live: https://agentrail-delta.vercel.app**

Vercel, root directory `web`, framework Next.js, Node 22. The workspace packages are TypeScript
sources compiled by Next (`transpilePackages`), so the whole repo is needed at build time.

## Owner actions

`REVOKE` and create-agent need the owner's wallet (wagmi, injected connector, Hedera testnet and
Base Sepolia). A visitor sees both, reads what they do, and cannot press them; the gate is the
connected address matching the owner. The wallet signs; the app never holds a key.
