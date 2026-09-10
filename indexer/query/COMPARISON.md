# What became easier

The Composable track asks for it to be shown, not asserted. Same question, two ways: *everything
`databot.agentrail.eth` (`ensNode 0x320d329c…d4ae`) was allowed and refused to do, on every chain.*

## WITH the shared schema — one query, one key, three chains

The one string, `HISTORY_QUERY` in [`src/history.ts`](src/history.ts), sent verbatim to each source:

```graphql
query History($ensNode: Bytes!) {
  mandates(where: { ensNode: $ensNode }) {
    id chain ensName owner agent expiry active
    permissions { target perTxLimit totalLimit spentTotal source targetChain }
    actions { kind timestamp target amount allowed blockReason errorCode txHash }
  }
}
```

and the merge is `[...sepolia, ...base, ...solana]`. Output of `yarn history` on 2026-09-10:

```
0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae

  sepolia  1 mandate(s), 0 action(s)   https://api.studio.thegraph.com/query/120234/agentrail/v0.1.0
  base     1 mandate(s), 22 action(s)  https://api.studio.thegraph.com/query/120234/agentrail-base/v0.1.0
  solana   1 mandate(s), 35 action(s)  substreams:devnet.sol.streamingfast.io:443

  chain    kind             allowed  reason         amount      target                                        tx
  base     authorize        true                         42  0x301672eef23f0e5f165cfba26762702f20a74430    0x253baf36fd2d23…
  base     authorize        true                         42  0x301672eef23f0e5f165cfba26762702f20a74430    0x0a2e3372e1b8fb…
  base     authorize        true                         42  0x301672eef23f0e5f165cfba26762702f20a74430    0x30f3405774afe4…
  base     authorize        true                         42  0x301672eef23f0e5f165cfba26762702f20a74430    0x30eed8c58e7418…
  … (22 Base rows: every gate pass since the contract was deployed, the four Phase 3 Graph payments among them)
  solana   execute_payment  true                    1500000  6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a  Smn9kZw7v9aSak57…
  solana   execute_payment  false    OVER_BUDGET     2500000  6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a  3ERKutFSUki6a69V…
  solana   execute_payment  false    OVER_BUDGET     1000000  6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a  4q7CHVcyUgRmBAN5…
  solana   verify           true                     500000  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA   4Yq1XexENucm2J4M…
  solana   verify           false    NOT_PERMITTED         0  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA   CxiAWzYGKCxSNohi…
  … (35 Solana rows: every demo run since Phase 1)

  3 mandate rows on 3 chains, 57 actions, 15 blocked (6007 ×6, 6008 ×5, 6006 ×4)
```

The Sepolia row carries the name, the ERC-8004 agent,
the `rail.*` records and the published allow-list; the Base row the EVM caps and every authorized
spend; the Solana row the caps and every attempt, refused ones included. Same fields, same ids.

The reader is 60 lines. Adding a fourth chain is one more source URL.

## WITHOUT it — three shapes, three keys, a merge by hand

What the same answer costs when each chain is indexed in its own native vocabulary.

**1. Sepolia, ENS-shaped.** Names are labels under a parent; records are `(node, key, value)` text.
The mandate is a token id that can change (`TokenRegenerated`); the "agent" is the ERC-1155 owner;
the caps live inside a JSON string.

```graphql
{
  labelRegistereds(where: { label: "databot" }) { tokenId labelHash owner expiry }
  textChangeds(where: { node: "0x320d…", key_in: ["rail.allowed", "rail.agent.solana", "rail.erc8004"] }) { key value }
}
```
→ compute `node = keccak(parent ‖ labelHash)`, parse `rail.allowed` JSON, decode base58 targets.

**2. Base Sepolia, event-shaped.** Everything keys by a `bytes32 mandateId` that only
`MandateCreated` maps back to the ENS node; spend totals are running counters on events.

```graphql
{
  mandateCreateds(where: { ensNode: "0x320d…" }) { mandateId owner agent expiry }
  spendAuthorizeds(where: { mandateId: "0xcc38…" }) { destination amount spendTotal ref }
  mandateRevokeds(where: { mandateId: "0xcc38…" }) { id }
}
```
→ first query for the id, then query again by id, then derive `active` from the last create vs
revoke, then convert `spendTotal` counters into per-permission state.

**3. Solana, instruction-shaped.** No events. Rows are `(signature, instruction index)` with
base58 accounts and a program error number in the transaction meta; the join key is an argument of
`create_mandate` or a byte offset in an account. A refusal is a *failed* transaction, which most
indexes drop.

```
substreams run … map_instructions  →  { signature, ix: 0, disc: 56040707788be88b, accounts: [pda, agent, from, dest, tokenProgram], data: 8 bytes, meta.err: InstructionError(0, Custom(6007)) }
```
→ decode the discriminator, pull `amount` from bytes 8..16, map `Custom(6007)` to a reason,
resolve `pda → ensNode` through a store, and re-key everything to the ENS node.

Then the merge: three id formats (`tokenId` / `bytes32` / `base58 pda`), three notions of
"active", three encodings of the payee (address / address / token account), and three time bases,
reconciled in client code every time the question is asked.

## The difference, in one line

With the schema: the question is asked once and the answer is already merged. Without it: three
questions in three dialects, and the merge is the product's hardest code.
