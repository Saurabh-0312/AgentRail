# @agentrail/web

The dashboard. Paste an agent's ENS name and see what it may do: its identity, its permissions
and live caps on every chain, every action it took and every one it was refused, the services it
can discover, and how a real model was tricked and stopped.

Every key stays on the server. The browser only ever calls this app's own API.

## Pages

| Route | What a judge sees |
|---|---|
| `/` | one statement, one input, three example chips, a live status strip with a real dot per chain |
| `/agent/<name>` | identity header with per-chain status and expiry · **owner actions** (revoke, create agent) · permissions per chain with live spend bars and the published `rail.allowed` ceiling · raw records · activity summary linking to the feed |
| `/activity` | one feed across three chains; **blocked rows loud**, a prominent Blocked filter, sticky header, every tx linked |
| `/services` | the three services resolved from ENS, price in USDC, the rogue one marked from its own payee |
| `/attack` | the poisoned advisory, the model's words as a callout, four reverted signatures as a sequence, the protective action as before/after |

## Amounts

Chains and the index store base units; the page shows the human value first and the raw units
second, everywhere, through one helper (`lib/units.ts`): `formatUnits(amount, decimals, symbol)`.
USDC is 6 decimals on all three chains (Hedera HTS `0.0.429274`, Base Sepolia
`0x036CbD53…`, the Solana devnet mint), HBAR 8, SOL 9. So `30000` reads `0.03 USDC (30,000 units)`
and `42` reads `0.000042 USDC`. The create-agent form converts as you type.

## Themes and motion

Dark is the default; the toggle in the header switches to light and remembers the choice
(`?theme=light` in the URL also works). Both palettes are CSS variables in `app/globals.css`;
components never carry a hex value. Motion is CSS: sections rise once on first paint, spend bars
grow to their value, headline counts climb once, healthy status dots breathe, blocked rows flash
red once. All of it is off under `prefers-reduced-motion`.

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
yarn workspace @agentrail/web test             # routes, feed rendering, owner gating, unit formatter, secret isolation
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

## Create agent on Solana

The Solana form is its own component (`components/solana-create.tsx`), because the permission
model is a different shape: the EVM gates on destination and amount, Solana on program, which
instructions, discriminator width and amount. The owner connects a Solana wallet (Phantom or any
Wallet Standard wallet; a separate connection from the EVM one) and composes permissions of two
kinds: a payee (`execute_payment` to a token account, with caps) or a program (`verify`: pick the
instructions from the catalogue in `packages/sdk/src/solana/catalogue.ts`, dangerous ones flagged,
or paste a program id, a width and raw discriminators under Advanced). The form derives and shows
the mandate PDA and the ENS namehash before anything is signed, refuses more than 16 permissions or
8 discriminators per program, and shows the human value beside every base-unit cap.

Three kinds of transaction, shown as steps with linked signatures: `create_mandate`,
`add_permission` once per entry, then `spl-token approve` from the owner's token account to the PDA
for the lifetime caps (skipped when the PDA is already the delegate for enough). Program errors
(`6002 PermissionsFull`, `6004 DuplicatePermission`, `6011`, `6012`, `6013`) are named on the step.
The mandate is read back from the chain and shown with its allowed instructions and, next to them,
the known instructions it does not allow. The SPL delegation is Solana's allowance, so the same
"not funded" panel serves all three chains.

## Activate Agent

One click on `/agent/<name>` runs one monitor pass on the server and streams every step to the
page as it happens (Server-Sent Events from `app/api/agent/run/route.ts`): reading its own mandate,
the discovery pass over published subgraphs, the drills, buying price data through the mandate,
the three rules, the verdict. The route calls `runMonitor` and nothing else; there is no path to
the attack or defend stages and no mode parameter. The runtime is the agent-only one
(`agent/src/runtime-agent.ts`): the agent's keys from the server environment, the mandates the
owner already issued, Solana read-only, so a click can never make the owner sign.

The button is not owner-gated, because a judge must be able to press it, so the remaining budget
per chain is shown first and the copy says whose USDC it spends. One run at a time globally, a
short cooldown per client. A refusal renders red with its code and the run continues; when the
mandate's caps are the reason, the page says so: the agent asked, the gate said no, no money
moved. `maxDuration` is set to the plan maximum; if the connection ends before the run does, the
entries already delivered stay on screen with an "ended early" note.

Server variables for it (Vercel, in addition to the seven above): `GEMINI_API_KEY` or
`GROQ_API_KEY`, `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY` (the agent's x402 payer), optionally
`AGENT_EVM_PRIVATE_KEY` for Base, `ALICE_WALLET` (the watched wallet, public). Never the deployer
key.

## Owner actions

`REVOKE`, `Delegate funds` and create-agent sit directly under the identity header and need the
owner's wallet (wagmi, injected connector, Hedera testnet and Base Sepolia). A visitor sees them
all, reads what they do, and cannot press them; the gate is the connected address matching the
owner. The wallet signs; the app never holds a key.

Create agent is three signatures: `createMandate`, `addPermission`, then the token's
`approve(EvmMandate, amount)`. The third is the non-custodial mechanism itself: `executePayment`
pulls with `transferFrom`, so a mandate without an allowance looks active and cannot pay. The token
defaults per chain from `lib/units.ts` (USDC on Base Sepolia, HTS USDC `0.0.429274` on Hedera as
its long-zero address) and can be overridden; the amount pre-fills from the lifetime cap; the
current allowance is read first and the step is skipped when it already covers the cap. Every EVM
mandate on the agent page shows its allowance next to what its caps still permit, and an
under-funded one is flagged with a button that opens the delegate card. The allowance is per owner
and per contract, shared by every mandate that owner issued on the chain. Solana's delegation
(`spl-token approve` on the owner's token account) is still set from the owner's CLI.
