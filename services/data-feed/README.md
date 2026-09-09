# @agentrail/data-feed

The shop. An x402-gated market-data service on Hedera testnet, settled through the
[Blocky402](https://api.testnet.blocky402.com) facilitator. This is what the agent discovers,
budgets for, and pays.

## What it sells

`GET /price/:symbols` returns live spot prices (Coinbase, CoinGecko fallback) for up to five
symbols, for example `/price/SOL,HBAR,ETH`. Nothing is a fixture: every paid response is
fetched at request time.

**Pay-per-call, metered by query.** One symbol costs one unit; three symbols cost three. The
402 challenge states the exact amount for that query, so an agent can budget before it signs.

| Endpoint | Paid | Purpose |
|---|---|---|
| `GET /price/:symbols` | yes | the data |
| `GET /pricing` | no | the schedule: unit price, asset, supported symbols |
| `GET /receipts/:payer` | no | what a payer has bought, checkable against the Mirror Node |
| `GET /health` | no | network, asset, payTo, fee payer |

## Payment flow (x402 v2)

```
agent  GET /price/SOL,HBAR                      -> 402 { accepts: [requirements] }
agent  sign exact Hedera transfer (amount, asset, payTo, feePayer from the 402)
agent  GET /price/SOL,HBAR  X-PAYMENT: <base64>
feed   POST facilitator /verify                 -> isValid
feed   fetch live quotes
feed   POST facilitator /settle                 -> transaction id   (once, server-side only)
feed   200 { data, payment: { transactionId, hashscan }, metering }
```

The feed talks the facilitator protocol directly: `GET /supported` for the fee payer, then
`/verify` and `/settle`. Only the server settles, exactly once per payment header. The
facilitator's success claim is not the record; the Mirror Node is.

## Running

```
cp ../../.env.example ../../.env   # fill HEDERA_* and the seller account
yarn start                          # http://localhost:4021
node --env-file=../../.env scripts/buy.ts   # reference buyer: 402 -> sign -> pay -> Mirror Node
```

Pricing defaults to HTS USDC `0.0.429274` (6 decimals) at 0.01 USDC per symbol. Set
`FEED_ASSET=0.0.0` to price in HBAR (0.1 HBAR per symbol). `payTo` must never be the payer:
a self-transfer nets to zero and the facilitator rejects it with `amount_mismatch`.

One-time Hedera setup (associates the buyer with USDC, creates a seller with unlimited automatic
token associations): `node --env-file=.env scripts/hedera-setup.ts` from the repo root, then fund
the buyer from [Circle's faucet](https://faucet.circle.com) (Hedera Testnet, 20 USDC / 2 h).

## Hosting

The repo carries a Render blueprint (`render.yaml` at the root) and a Railway config
(`railway.json`). Both run `yarn workspace @agentrail/data-feed start:hosted`, which needs no
`.env`: the feed holds no secrets, only the public seller account and the facilitator URL. The
402 `resource` uses `FEED_PUBLIC_URL`, falling back to `RENDER_EXTERNAL_URL` or
`RAILWAY_PUBLIC_DOMAIN`. On Render: New → Blueprint → pick the repo → apply.

## Tests

`yarn test` runs the vitest suite against an injected facilitator: the 402 challenge, per-query
metering, malformed and mismatched payment headers, verify failure, single settlement, replayed
headers, and upstream failure. The live path is exercised by `scripts/buy.ts`.
