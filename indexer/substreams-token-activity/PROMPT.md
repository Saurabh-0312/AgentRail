# Substreams SKILLs — one-prompt pipeline

The featured Substreams challenge: *use the Substreams SKILLs to go from a single natural-language
prompt to a working, deployed Substreams pipeline.*

Skills used: `substreams-solana` and `substreams-dev` from
[streamingfast/substreams-skills](https://github.com/streamingfast/substreams-skills) (v1.6.0),
loaded into Claude Code (`claude --plugin-dir ./substreams-skills`). The skill's pre-flight
answers are all inside the prompt, as its evaluation notes recommend ("be specific in prompts").

## The prompt

> Build a Substreams for **Solana devnet** that indexes the **SPL Token program**
> (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) for one token account only:
> `AzbPCoBsT4PckeqYMgukhd1u5hhbe48UxBvczVAqdeU9` (Alice's devnet USDC account, the one delegated to
> her AgentRail mandate). Track four instructions — `Transfer` (3), `TransferChecked` (12),
> `Approve` (4), `Revoke` (5) — wherever that account is the source, including CPI inner
> instructions. One protobuf message per instruction with decoded args and named accounts:
> transfers carry slot, signature, source, destination, amount, authority, and whether the
> authority is the mandate PDA `7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a`; approvals carry
> source, delegate, owner, amount; revokes carry source, owner. Start at slot 495587900, use
> `substreams protogen` for bindings, expose a single map module `map_token_activity`, and make it
> runnable against `devnet.sol.streamingfast.io:443` with `substreams run`.

## The result

`indexer/substreams-token-activity/` — manifest, proto, `src/lib.rs`, built and run through the
provider. See `README.md` in that directory for the run and the rows it returned.

What the skill contributed, concretely: `walk_instructions()` (top-level + inner instructions in
one pass, which is what catches the CPI transfers the mandate PDA signs), the SPL Token
discriminators and account layouts (`Transfer` = 3 `[source, dest, authority]`, `TransferChecked`
= 12 `[source, mint, dest, authority]`, `Approve` = 4 `[source, delegate, owner]`, `Revoke` = 5
`[source, owner]`), the `b58!` compile-time constant macro, the rule of one typed message per
instruction (no JSON blobs), and the manifest / Cargo layout.

Why this pipeline and not a copy of `substreams/`: it answers the question the mandate index
cannot — *did anything other than the mandate ever move Alice's USDC?* Every transfer out of the
delegated account is attributed to its signing authority; `viaMandate` is true exactly when the
AgentRail PDA signed. Composed with `agentrail_mandates`, that is the custody proof.
