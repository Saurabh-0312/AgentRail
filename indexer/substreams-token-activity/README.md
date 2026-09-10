# agentrail_token_activity — who moved Alice's USDC? (Substreams, one prompt)

Built from a single natural-language prompt with the Substreams SKILLs (`substreams-solana`,
`substreams-dev`). The prompt and what the skills contributed are in [PROMPT.md](PROMPT.md).

Watches one SPL Token account on Solana devnet, `AzbPCoBsT4PckeqYMgukhd1u5hhbe48UxBvczVAqdeU9`
(the owner's USDC account, delegated to the AgentRail mandate PDA), and emits one typed message per
instruction where that account is the source:

| Message | SPL Token instruction | Named accounts | Flag |
|---|---|---|---|
| `Transfer` | 3 | source, destination, authority | `via_mandate` = authority is the mandate PDA; `inner` = reached by CPI |
| `TransferChecked` | 12 | source, mint, destination, authority | same |
| `Approve` | 4 | source, delegate, owner | `delegate_is_mandate` |
| `Revoke` | 5 | source, owner | – |

`walk_instructions()` visits inner instructions, which is how `execute_payment`'s CPI transfers
(signed by the PDA) are attributed. Composed with `agentrail_mandates`, this is the custody proof:
every movement of the delegated account is either the mandate PDA acting through the program, or
the owner herself.

## Live run (2026-09-10, `devnet.sol.streamingfast.io:443`, slots 495587900 → 495600000)

```
APPROVE   100000000 USDC units  delegate 7TuT4p76… (the mandate PDA)         slot 495588914
TRANSFER    1500000  to 6rz86Hue…  authority 7TuT4p76…  viaMandate inner   slot 495588920
APPROVE   100000000               delegate 7TuT4p76…                        slot 495589168
TRANSFER    1500000  to 6rz86Hue…  authority 7TuT4p76…  viaMandate inner   slot 495589178
TRANSFER    1500000  to 6rz86Hue…  authority 7TuT4p76…  viaMandate inner   slot 495589200
TRANSFER    1500000  to 6rz86Hue…  authority 7TuT4p76…  viaMandate inner   slot 495589210
APPROVE   100000000               delegate 7TuT4p76…                        slot 495599880
TRANSFER    1500000  to 6rz86Hue…  authority 7TuT4p76…  viaMandate inner   slot 495599884
TRANSFER    1500000  to 6rz86Hue…  authority 7TuT4p76…  viaMandate inner   slot 495599894
TRANSFER    1500000  to 6rz86Hue…  authority 7TuT4p76…  viaMandate inner   slot 495599899
TRANSFER     500000  to 6rz86Hue…  authority 55FJao82… (the owner, Transfer + verify demo)  slot 495599944
```

Every delegated movement was signed by the PDA; the refused attempts (6007 / 6008) moved nothing
and are therefore absent here and present in `agentrail_mandates` — the two packages answer
complementary questions.

Published: **https://substreams.dev/packages/agentrail-token-activity/v0.1.0** (`substreams gui agentrail-token-activity@v0.1.0`).

## Run

```
. ../../.substreams.env
cargo test
cargo build --target wasm32-unknown-unknown --release && substreams pack substreams.yaml
substreams run -e devnet.sol.streamingfast.io:443 agentrail-token-activity-v0.1.0.spkg map_token_activity -s 495587900 -t +12100 --limit-processed-blocks 0 -o jsonl
```

Params: `account:<token account>;mandate:<authority to flag>` — point it at any delegated account.
