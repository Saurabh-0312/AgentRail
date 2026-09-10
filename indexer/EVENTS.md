# Event inventory — what each chain actually emits

Read before writing a mapping. Every row below was confirmed against live logs on 2026-09-10
(`cast logs` on Sepolia and Base Sepolia; `getTransaction` on Solana devnet). Counts are the
totals since deployment, so a mapping can be checked against them after the first sync.

Three sources feed one schema (`schema.graphql`). The join key is the ENS namehash of the mandate
name, `ensNode`: written by the owner into the ENS registry, the Solana mandate account
(offset 80) and the EVM mandate (`MandateCreated.ensNode`). Same 32 bytes on every chain.

| Chain | Source | Kind | Start | Live rows |
|---|---|---|---|---|
| Sepolia | `AgentRailRegistry` `0x68822ce9109D9d71e99b07703cF6c851D0229AA9` | subgraph, events | block **11667466** (`RegistryCreated`) | 19 logs |
| Sepolia | Resolver proxy `0xbfce4e394832c879fd2d95dae4F02259AFd23C16` | subgraph, events | block 11667466 | 62 logs, 57 `TextChanged` |
| Sepolia | ERC-8004 `IdentityRegistry` `0x8004A818BFB912233c491871b3d84c89A494BD9e` | subgraph, events | block **11668605** (our agent's `Registered`) | agent id 10190 + every later registration |
| Base Sepolia | `EvmMandate` `0x68822ce9109D9d71e99b07703cF6c851D0229AA9` | subgraph, events | block **46598029** (deploy tx `0xdb5b4f38…f406a`) | 48 logs |
| Solana devnet | program `GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj` | Substreams, instruction data + tx meta | slot **495587900** (just before the first Phase 1 tx at 495587905; Gate 1 reverts at 495589192 / 495589219 / 495599949, latest demo run from 495753245) | successes and reverts |

> ⚠️ `0x68822ce9…` is `AgentRailRegistry` on Sepolia but `EvmMandate` on Base Sepolia (deployer nonce 0
> on both). Same address, different ABI. The Sepolia subgraph loads `AgentRailRegistry.json`; the Base
> subgraph loads `EvmMandate.json`. Pointing either at the other chain indexes nothing.

---

## Sepolia — `AgentRailRegistry` (extends ENSv2 `PermissionedRegistry`)

Signatures from `contracts/out/AgentRailRegistry.sol/AgentRailRegistry.json` (17 events). Only the
ones that carry mandate state are handled; the rest are listed so nobody guesses.

| Event | Emitted by | Seen | Handled → entity |
|---|---|---|---|
| `MandateIssued(uint256 indexed tokenId, string label, address indexed agent, uint64 expiry, address resolver)` | `issueMandate` (ours) | 1 (`databot`, block 11667474) | **Mandate** `<ensNode>:sepolia` created, `agent`, `expiry`, `active=true`, `ensName` |
| `LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)` | `register` (ENSv2) | 4 (`databot`, `feed`, `graph`, `rogue`) | **Service** for labels that are *not* mandates (the discovery directory); for the mandate label it records `owner = sender` |
| `LabelUnregistered(uint256 indexed tokenId, address indexed sender)` | `revokeMandate` / `unregister` | 0 | Mandate `active=false` (the ENS kill switch) |
| `ExpiryUpdated(uint256 indexed tokenId, uint64 indexed newExpiry, address indexed sender)` | `renewMandate` / `renew` | 0 | Mandate `expiry` |
| `ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender)` | `register`, `setResolver` | 4 | Mandate/Service `resolver` |
| `TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)` | ERC-1155 mint on register | 4 | not handled (owner comes from `LabelRegistered`) |
| `TokenResource(uint256 indexed tokenId, uint256 indexed resource)` | register | 4 | not handled |
| `EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)` | constructor (root roles) | 1 | not handled (zero roles on the agent is proven by the fork tests) |
| `RegistryCreated()` | constructor | 1 | not handled |
| `LabelReserved`, `SubregistryUpdated`, `URIUpdated`, `TokenRegenerated`, `ParentUpdated`, `ApprovalForAll`, `TransferBatch`, `URI` | ENSv2 | 0 | not handled |

**Deriving the join key.** `ensNode = keccak256(parentNode ‖ labelHash)` with
`parentNode = namehash("agentrail.eth") = 0xa8000cc4a2b775ac4243d66028f373b831eb4e4f43368868993e1bafa534eda8`
and `labelHash` from `LabelRegistered`. For `databot` this yields
`0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae`, the node written into the
Solana PDA and both EVM mandates. `tokenId` is the registry's handle for the label and can change
on re-registration (`TokenRegenerated`), so the mapping keeps a `tokenId → labelHash` lookup.

## Sepolia — Resolver proxy (`ERC1967Proxy` over ENSv2 `PermissionedResolver`)

| Event | Seen | Handled → entity |
|---|---|---|
| `TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)` | 57 | **MandateRecord** for every `rail.*` key on a mandate node; **Service** fields for `rail.endpoint` / `rail.chain` / `rail.price` / `rail.token` / `rail.scheme` / `description` on a service node; **Permission** rows parsed from the `rail.allowed` JSON on the mandate node (the published allow-list, one row per payee) |
| `EACRolesChanged` (2), `VersionChanged`, proxy `Upgraded` / `Initialized` | 5 | not handled |

Keys observed on the mandate node `0x320d329c…`: `rail.version`, `rail.agent.solana`,
`rail.agent.hedera`, `rail.agent.hedera.account`, `rail.agent.base`, `rail.mandate.pda`,
`rail.erc8004`, `rail.allowed`, `rail.status` (rewritten several times as Phase 2/3 republished
them). On the service nodes `0x1c561a5c…` (feed), `0xf944d3d5…` (graph), `0x97d5e9c8…` (rogue):
the five `rail.*` discovery keys plus `description`.

`rail.erc8004 = eip155:11155111:0x8004A818…:10190` links the Mandate to its ERC-8004 **Agent**.

## Sepolia — ERC-8004 `IdentityRegistry` (the standardized base)

Receipt of our registration tx `0xf33a7039…3eec` (block 11668605) shows the events the registry
emits; the Agent0 subgraph handles the same four.

| Event | Handled → entity |
|---|---|
| `Registered(uint256 indexed agentId, string agentURI, address indexed owner)` | **Agent** `11155111:<agentId>` (Agent0 shape) |
| `MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)` | **AgentMetadata** `11155111:<agentId>:<key>` |
| `URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)` | Agent `agentURI`, `updatedAt` |
| `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)` | Agent `owner` |

Start block 11668605 keeps the sync small; every agent registered from then on is indexed, ours
included.

---

## Base Sepolia — `EvmMandate`

Signatures from `contracts/out/EvmMandate.sol/EvmMandate.json` (6 events). All 48 live logs sit in
blocks 46602556–46604947.

| Event | Seen | Handled → entity |
|---|---|---|
| `MandateCreated(bytes32 indexed mandateId, address indexed owner, address indexed agent, bytes32 ensNode, uint64 expiry)` | 9 | **Mandate** `<ensNode>:base`, `owner`, `agent`, `expiry`, `active=true`; `mandateId → ensNode` lookup |
| `PermissionAdded(bytes32 indexed mandateId, address indexed destination, uint256 spendLimit, uint256 perTxLimit)` | 9 | **Permission** `<mandateId>:<destination>` with `totalLimit`, `perTxLimit`, `spentTotal=0` |
| `PermissionRemoved(bytes32 indexed mandateId, address indexed destination)` | 0 | Permission removed |
| `MandateRevoked(bytes32 indexed mandateId)` | 8 | Mandate `active=false` |
| `SpendAuthorized(bytes32 indexed mandateId, address indexed destination, uint256 amount, uint256 spendTotal, bytes32 ref)` | 22 | **Action** `allowed=true`, `kind="authorize"`, `amount`, `target`, `ref`, `txHash`; Permission `spentTotal` |
| `PaymentExecuted(bytes32 indexed mandateId, address indexed destination, address indexed token, uint256 amount, uint256 spendTotal)` | 0 | **Action** `allowed=true`, `kind="payment"`; Permission `spentTotal` |

**Blocked attempts on the EVM do not emit.** `EvmMandate.check` is a view: the SDK asks it before
`authorize`, and a refusal never becomes a transaction (0 paid requests, no gas). The 22
`SpendAuthorized` rows are the 22 gate passes; refusals are visible only on Solana, where the gate
and the transfer are one instruction and the rejection is a landed, failed transaction.

The same contract is deployed on Hedera testnet, but Hedera is not indexed (no Graph provider);
its record is the HCS topic `0.0.10440940` and the Mirror Node.

---

## Solana devnet — program `GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj`

**No events. Do not add any.** Everything comes from two places in the block:

1. **Instruction data** — the 8-byte Anchor discriminator followed by Borsh-encoded args, decoded
   with `target/idl/agentrail.json`. Accounts by position.
2. **Transaction meta** — `meta.err` (`InstructionError: [index, { Custom: code }]`) and
   `meta.log_messages` (`… Error Code: PerTxLimitExceeded. Error Number: 6007 …`). A reverted
   transaction is still in the block, with its instruction data intact. That is what makes the
   refusals indexable.

| Instruction | Discriminator | Args | Accounts | Handled → entity |
|---|---|---|---|---|
| `create_mandate` | `e6aa9e4421a9109e` | `ens_node: [u8;32]`, `expiry: i64` | mandate, owner, agent, system_program | **Mandate** `<ensNode>:solana`, `owner`, `agent`, `expiry`, `active=true`; `mandate PDA → ensNode` lookup |
| `add_permission` | `90427c4ce861634d` | `program_id`, `discriminators: Vec<[u8;8]>`, `discriminator_size: u8`, `spend_limit: u64`, `per_tx_limit: u64` | mandate, owner | **Permission** `<pda>:<program_id>` with `instructions`, caps |
| `remove_permission` | `7a33baee4e68cdcc` | `program_id` | mandate, owner | Permission removed |
| `revoke_mandate` | `fc618c77432bb16c` | – | mandate, owner | Mandate `active=false` (account closed) |
| `execute_payment` | `56040707788be88b` | `amount: u64` | mandate, agent, from, destination, token_program | **Action** `kind="execute_payment"`, `target=destination`, `amount`; `allowed = meta.err == null`; Permission `spentTotal` on success |
| `verify` | `85a18d3078c65896` | `target_ix_index: u8`, `declared_amount: u64` | mandate, agent, instructions_sysvar | **Action** `kind="verify"`, `target` = program id of the sibling instruction at `target_ix_index`, `amount = declared_amount`; `allowed = meta.err == null` |

`ens_node` is also readable from the mandate account at **offset 80** (8-byte discriminator + 72),
which is how a payment's `ensNode` is resolved when the create was outside the streamed range.

**Error code → `blockReason`** (the reverts are the product):

| Code | Anchor error | `blockReason` |
|---|---|---|
| 6000 | `NotActive` | `REVOKED` |
| 6001 | `Expired` | `EXPIRED` |
| 6005 | `ProgramNotAllowed` | `NOT_PERMITTED` |
| **6006** | **`InstructionNotAllowed`** | **`NOT_PERMITTED`** |
| **6007** | **`PerTxLimitExceeded`** | **`OVER_BUDGET`** |
| **6008** | **`SpendLimitExceeded`** | **`OVER_BUDGET`** |
| 6010 | `NotTheAgent` | `NOT_PERMITTED` |
| 6015 | `InvalidTargetInstruction` | `NOT_PERMITTED` |
| 6016 | `DestinationNotAllowed` | `NOT_PERMITTED` |
| 6017 | `TokenAccountNotOwned` | `NOT_PERMITTED` |
| any other failure | – | `FAILED` (kept, never dropped) |

Known devnet rows to check the module against (run of 2026-09-09 18:19 UTC):

| Slot | Signature | Expected |
|---|---|---|
| 495753253 | `4F5o6FqyV8uA7G4bQ8Vy…` | Mandate created |
| 495753288 | `5G6AwSxBMP6GhgLQJFbb…` | `execute_payment` 1.5 USDC, `allowed=true` |
| 495753299 | `26MbYySwyhPn5fDNpYXz…` | `execute_payment` 2.5 USDC, **`allowed=false` 6007 OVER_BUDGET** |
| 495753422 | `rirCCxsuHrZ4SbzuorFs…` | `execute_payment` 1.0 USDC, **`allowed=false` 6008 OVER_BUDGET** |
| 495753444 | `2448msSAaND6ahE5w7d9…` | `verify` on SPL `SetAuthority`, **`allowed=false` 6006 NOT_PERMITTED** |
| 495753437 | `2NU83VM4Uk3x95P2tsFS…` | `verify` on SPL `Transfer`, `allowed=true` |

**Rule: no block filter on an index built from successful transactions.** solana-common's
`program_ids_without_votes` index only sees transactions that succeeded, so a block whose only
AgentRail transaction reverted is skipped by a `blockFilter` on it and the refusal never reaches the
module. Verified live on 2026-09-10: with the filter, slots 495753299 / 495753422 / 495753444
(6007 / 6008 / 6006) produced nothing; without it, all three arrive as `allowed=false`. The module
therefore reads raw `sf.solana.type.v1.Block` and pays the cost of touching every block.

**Streaming.** Solana devnet is served by StreamingFast's `devnet.sol.streamingfast.io:443`
(and Pinax's `soldev.substreams.pinax.network:443`), authenticated with The Graph Market token
from `substreams auth`; first streamable block 391,843,999; verified with a one-block run of
`solana-common@v0.4.0` on 2026-09-10. The networks registry lists **no subgraph service and no graph-node protocol for
`solana-devnet`**, so the Solana rows cannot be hosted in Subgraph Studio; they are streamed from
The Graph Market and merged under the shared schema by the reader in `indexer/query`.

---

## What this means for the schema

- `Mandate.id = <ensNode>:<chain>` with `chain ∈ { sepolia, solana, base }`; `ensNode` on every row.
- `Action` rows come from Base (`allowed=true` only, by construction) and Solana (both).
- `Permission` rows come from all three: the ENS `rail.allowed` mirror on Sepolia, `PermissionAdded`
  on Base, `add_permission` on Solana. Comparing them is how drift between the published allow-list
  and the enforced caps becomes visible.
- `Agent` (ERC-8004, Agent0 shape) comes from Sepolia and is linked from the Mandate through
  `rail.erc8004`.
