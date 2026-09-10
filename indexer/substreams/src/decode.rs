//! Instruction decoding for the AgentRail program: 8-byte Anchor discriminator + Borsh args, accounts
//! by position (`target/idl/agentrail.json`). Pure functions over the Firehose block model, so the
//! same code runs in the wasm module and in `cargo test` on the host.
use substreams_solana::pb::sf::solana::r#type::v1::{Block, ConfirmedTransaction};

use crate::errors::{self, Failure};
use crate::pb::agentrail::v1::{Action, Activity, Mandate, Permission};

pub const CHAIN: &str = "solana";

/// Anchor discriminators from the IDL (sha256("global:<name>")[..8]).
pub const DISC_CREATE_MANDATE: [u8; 8] = [0xe6, 0xaa, 0x9e, 0x44, 0x21, 0xa9, 0x10, 0x9e];
pub const DISC_ADD_PERMISSION: [u8; 8] = [0x90, 0x42, 0x7c, 0x4c, 0xe8, 0x61, 0x63, 0x4d];
pub const DISC_REMOVE_PERMISSION: [u8; 8] = [0x7a, 0x33, 0xba, 0xee, 0x4e, 0x68, 0xcd, 0xcc];
pub const DISC_REVOKE_MANDATE: [u8; 8] = [0xfc, 0x61, 0x8c, 0x77, 0x43, 0x2b, 0xb1, 0x6c];
pub const DISC_EXECUTE_PAYMENT: [u8; 8] = [0x56, 0x04, 0x07, 0x07, 0x78, 0x8b, 0xe8, 0x8b];
pub const DISC_VERIFY: [u8; 8] = [0x85, 0xa1, 0x8d, 0x30, 0x78, 0xc6, 0x58, 0x96];

/// `program:<base58>` from the module params. Anything else is a hard error: an index that decodes
/// the wrong program silently is worse than one that refuses to start.
pub fn program_from_params(params: &str) -> Result<Vec<u8>, String> {
    for part in params.split(';') {
        if let Some(id) = part.trim().strip_prefix("program:") {
            return bs58::decode(id.trim()).into_vec().map_err(|e| format!("bad program id {id}: {e}"));
        }
    }
    Err(format!("params must contain program:<base58>, got {params:?}"))
}

/// `mandate:<pda base58>=<ens_node hex>` hints from the module params.
pub fn mandate_hints(params: &str) -> Vec<(String, String)> {
    params
        .split(';')
        .filter_map(|part| part.trim().strip_prefix("mandate:"))
        .filter_map(|kv| kv.split_once('='))
        .map(|(pda, node)| (pda.trim().to_string(), node.trim().to_lowercase()))
        .collect()
}

pub fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

pub fn mandate_id(ens_node_hex: &str) -> String {
    format!("{ens_node_hex}:{CHAIN}")
}

fn u64_le(data: &[u8], at: usize) -> Option<u64> {
    data.get(at..at + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap()))
}

fn i64_le(data: &[u8], at: usize) -> Option<i64> {
    data.get(at..at + 8).map(|b| i64::from_le_bytes(b.try_into().unwrap()))
}

/// What the block says about one transaction, resolved once.
struct TxContext<'a> {
    tx: &'a ConfirmedTransaction,
    keys: Vec<&'a Vec<u8>>,
    signature: String,
    failure: Option<Failure>,
    log_error: Option<u32>,
    slot: u64,
    timestamp: i64,
}

impl<'a> TxContext<'a> {
    fn account(&self, ix_accounts: &[u8], position: usize) -> Option<String> {
        let idx = *ix_accounts.get(position)? as usize;
        self.keys.get(idx).map(|k| bs58::encode(k).into_string())
    }

    /// Was this instruction the one that failed, and why. A transaction that failed at another
    /// instruction is still a failure for every instruction in it (Solana transactions are atomic).
    fn verdict(&self, ix_index: usize) -> (bool, String, u32, String) {
        match &self.failure {
            None => (true, String::new(), 0, String::new()),
            Some(f) => {
                let this_one = f.instruction_index.map(|i| i as usize == ix_index).unwrap_or(false);
                let code = if this_one { f.custom_code.or(self.log_error) } else { None };
                let reason = if this_one { errors::block_reason(code) } else { errors::FAILED };
                (false, reason.to_string(), code.unwrap_or(0), code.map(errors::error_name).unwrap_or("").to_string())
            }
        }
    }
}

/// Decode every top-level instruction of `program` in the block. Failed transactions are included;
/// that is the point.
pub fn decode_block(program: &[u8], block: &Block) -> Activity {
    let mut out = Activity::default();
    let timestamp = block.block_time.as_ref().map(|t| t.timestamp).unwrap_or(0);
    for tx in block.transactions.iter() {
        let (Some(transaction), Some(meta)) = (tx.transaction.as_ref(), tx.meta.as_ref()) else { continue };
        let Some(message) = transaction.message.as_ref() else { continue };
        let ctx = TxContext {
            tx,
            keys: tx.resolved_accounts(),
            signature: tx.id(),
            failure: meta.err.as_ref().and_then(|e| errors::parse_transaction_error(&e.err)),
            log_error: errors::error_number_from_logs(meta.log_messages.iter()),
            slot: block.slot,
            timestamp,
        };
        for (i, ix) in message.instructions.iter().enumerate() {
            let Some(pid) = ctx.keys.get(ix.program_id_index as usize) else { continue };
            if pid.as_slice() != program {
                continue;
            }
            decode_instruction(&ctx, i, &ix.accounts, &ix.data, message, &mut out);
        }
    }
    out
}

fn decode_instruction(
    ctx: &TxContext,
    ix_index: usize,
    accounts: &[u8],
    data: &[u8],
    message: &substreams_solana::pb::sf::solana::r#type::v1::Message,
    out: &mut Activity,
) {
    if data.len() < 8 {
        return;
    }
    let disc: [u8; 8] = data[..8].try_into().unwrap();
    let (allowed, block_reason, error_code, error_name) = ctx.verdict(ix_index);
    let id = format!("{}:{}", ctx.signature, ix_index);

    match disc {
        DISC_CREATE_MANDATE => {
            // accounts: mandate, owner, agent, system_program · args: ens_node [u8;32], expiry i64
            let (Some(node), Some(expiry)) = (data.get(8..40), i64_le(data, 40)) else { return };
            let ens_node = hex0x(node);
            out.mandates.push(Mandate {
                id: mandate_id(&ens_node),
                ens_node,
                chain: CHAIN.into(),
                owner: ctx.account(accounts, 1).unwrap_or_default(),
                agent: ctx.account(accounts, 2).unwrap_or_default(),
                expiry,
                active: allowed,
                tx_hash: ctx.signature.clone(),
                slot: ctx.slot,
                timestamp: ctx.timestamp,
                pda: ctx.account(accounts, 0).unwrap_or_default(),
                kind: "create_mandate".into(),
            });
        }
        DISC_REVOKE_MANDATE => {
            if !allowed {
                return; // a revoke that did not land changes nothing
            }
            out.mandates.push(Mandate {
                id: String::new(), // filled by map_activity from the PDA
                ens_node: String::new(),
                chain: CHAIN.into(),
                owner: ctx.account(accounts, 1).unwrap_or_default(),
                agent: String::new(),
                expiry: 0,
                active: false,
                tx_hash: ctx.signature.clone(),
                slot: ctx.slot,
                timestamp: ctx.timestamp,
                pda: ctx.account(accounts, 0).unwrap_or_default(),
                kind: "revoke_mandate".into(),
            });
        }
        DISC_ADD_PERMISSION => {
            // args: program_id [u8;32], discriminators Vec<[u8;8]> (u32 len), discriminator_size u8,
            //       spend_limit u64, per_tx_limit u64
            if !allowed {
                return;
            }
            let (Some(target), Some(len)) = (data.get(8..40), data.get(40..44)) else { return };
            let len = u32::from_le_bytes(len.try_into().unwrap()) as usize;
            let mut at = 44;
            let mut instructions = Vec::with_capacity(len);
            for _ in 0..len {
                let Some(d) = data.get(at..at + 8) else { return };
                instructions.push(hex0x(d));
                at += 8;
            }
            let Some(&size) = data.get(at) else { return };
            let (Some(spend_limit), Some(per_tx_limit)) = (u64_le(data, at + 1), u64_le(data, at + 9)) else { return };
            let pda = ctx.account(accounts, 0).unwrap_or_default();
            out.permissions.push(Permission {
                id: format!("{pda}:{}", bs58::encode(target).into_string()),
                mandate_id: pda.clone(), // rewritten to the ens-keyed id by map_activity
                ens_node: String::new(),
                target: bs58::encode(target).into_string(),
                instructions,
                discriminator_size: size as u32,
                per_tx_limit,
                total_limit: spend_limit,
                tx_hash: ctx.signature.clone(),
                slot: ctx.slot,
                timestamp: ctx.timestamp,
                kind: "add_permission".into(),
            });
        }
        DISC_REMOVE_PERMISSION => {
            if !allowed {
                return;
            }
            let Some(target) = data.get(8..40) else { return };
            let pda = ctx.account(accounts, 0).unwrap_or_default();
            out.permissions.push(Permission {
                id: format!("{pda}:{}", bs58::encode(target).into_string()),
                mandate_id: pda,
                ens_node: String::new(),
                target: bs58::encode(target).into_string(),
                instructions: vec![],
                discriminator_size: 0,
                per_tx_limit: 0,
                total_limit: 0,
                tx_hash: ctx.signature.clone(),
                slot: ctx.slot,
                timestamp: ctx.timestamp,
                kind: "remove_permission".into(),
            });
        }
        DISC_EXECUTE_PAYMENT => {
            // accounts: mandate, agent, from, destination, token_program · args: amount u64
            let Some(amount) = u64_le(data, 8) else { return };
            out.actions.push(Action {
                id,
                mandate_id: String::new(),
                ens_node: String::new(),
                chain: CHAIN.into(),
                timestamp: ctx.timestamp,
                target: ctx.account(accounts, 3).unwrap_or_default(),
                amount,
                allowed,
                block_reason,
                tx_hash: ctx.signature.clone(),
                kind: "execute_payment".into(),
                error_code,
                agent: ctx.account(accounts, 1).unwrap_or_default(),
                slot: ctx.slot,
                pda: ctx.account(accounts, 0).unwrap_or_default(),
                error_name,
            });
        }
        DISC_VERIFY => {
            // accounts: mandate, agent, instructions_sysvar · args: target_ix_index u8, declared_amount u64
            let (Some(&target_ix), Some(amount)) = (data.get(8), u64_le(data, 9)) else { return };
            // the sibling instruction the mandate was asked about: its program id is the target
            let target = message
                .instructions
                .get(target_ix as usize)
                .and_then(|sib| ctx.keys.get(sib.program_id_index as usize))
                .map(|k| bs58::encode(k).into_string())
                .unwrap_or_default();
            out.actions.push(Action {
                id,
                mandate_id: String::new(),
                ens_node: String::new(),
                chain: CHAIN.into(),
                timestamp: ctx.timestamp,
                target,
                amount,
                allowed,
                block_reason,
                tx_hash: ctx.signature.clone(),
                kind: "verify".into(),
                error_code,
                agent: ctx.account(accounts, 1).unwrap_or_default(),
                slot: ctx.slot,
                pda: ctx.account(accounts, 0).unwrap_or_default(),
                error_name,
            });
        }
        _ => {}
    }
    let _ = ctx.tx;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use substreams_solana::pb::sf::solana::r#type::v1::{
        CompiledInstruction, Message, Transaction, TransactionError, TransactionStatusMeta, UnixTimestamp,
    };

    const PROGRAM: &str = "GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj";
    const PDA: &str = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";
    const SHOP_ATA: &str = "6rz86HueaUgA7ejoBTEKvR4JB9ef6LbGwXwN3DKmjZ3a";
    const AGENT: &str = "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV";
    const NODE: &str = "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae";
    const SPL_TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

    /// `getTransaction` (json encoding) of a real devnet transaction, see tests/fixtures.
    #[derive(Deserialize)]
    struct Fixture {
        signature: String,
        slot: u64,
        #[serde(rename = "blockTime")]
        block_time: i64,
        err: Option<serde_json::Value>,
        #[serde(rename = "logMessages")]
        log_messages: Vec<String>,
        #[serde(rename = "accountKeys")]
        account_keys: Vec<String>,
        instructions: Vec<FixtureIx>,
    }

    #[derive(Deserialize)]
    struct FixtureIx {
        #[serde(rename = "programIdIndex")]
        program_id_index: u32,
        accounts: Vec<u8>,
        data: String,
    }

    fn fixture(name: &str) -> Fixture {
        let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
    }

    /// The RPC shows `{"InstructionError":[i,{"Custom":n}]}`; the block carries the bincode bytes.
    fn err_bytes(err: &serde_json::Value) -> Vec<u8> {
        let arr = err.get("InstructionError").and_then(|v| v.as_array()).expect("fixture errors are instruction errors");
        let index = arr[0].as_u64().unwrap() as u8;
        let code = arr[1].get("Custom").and_then(|c| c.as_u64()).unwrap() as u32;
        let mut v = 8u32.to_le_bytes().to_vec();
        v.push(index);
        v.extend_from_slice(&25u32.to_le_bytes());
        v.extend_from_slice(&code.to_le_bytes());
        v
    }

    fn confirmed(f: &Fixture) -> ConfirmedTransaction {
        ConfirmedTransaction {
            transaction: Some(Transaction {
                signatures: vec![bs58::decode(&f.signature).into_vec().unwrap()],
                message: Some(Message {
                    header: None,
                    account_keys: f.account_keys.iter().map(|k| bs58::decode(k).into_vec().unwrap()).collect(),
                    recent_blockhash: vec![],
                    instructions: f
                        .instructions
                        .iter()
                        .map(|ix| CompiledInstruction {
                            program_id_index: ix.program_id_index,
                            accounts: ix.accounts.clone(),
                            data: bs58::decode(&ix.data).into_vec().unwrap(),
                        })
                        .collect(),
                    versioned: false,
                    address_table_lookups: vec![],
                }),
            }),
            meta: Some(TransactionStatusMeta {
                err: f.err.as_ref().map(|e| TransactionError { err: err_bytes(e) }),
                log_messages: f.log_messages.clone(),
                ..Default::default()
            }),
        }
    }

    fn block_of(names: &[&str]) -> Block {
        let fixtures: Vec<Fixture> = names.iter().map(|n| fixture(n)).collect();
        Block {
            slot: fixtures[0].slot,
            block_time: Some(UnixTimestamp { timestamp: fixtures[0].block_time }),
            transactions: fixtures.iter().map(confirmed).collect(),
            ..Default::default()
        }
    }

    fn program() -> Vec<u8> {
        bs58::decode(PROGRAM).into_vec().unwrap()
    }

    #[test]
    fn params_select_the_program_and_carry_mandate_hints() {
        assert_eq!(program_from_params("program:GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj").unwrap(), program());
        assert!(program_from_params("mandate:x=y").is_err());
        assert!(program_from_params("program:not-base58!").is_err());
        let hints = mandate_hints("mandate:7TuT=0xABCD; mandate:zzz=0x01");
        assert_eq!(hints, vec![("7TuT".into(), "0xabcd".into()), ("zzz".into(), "0x01".into())]);
        assert!(mandate_hints("program:x").is_empty());
    }

    #[test]
    fn create_mandate_carries_the_join_key_from_its_argument() {
        let a = decode_block(&program(), &block_of(&["create_mandate"]));
        assert_eq!(a.mandates.len(), 1);
        let m = &a.mandates[0];
        assert_eq!(m.ens_node, NODE);
        assert_eq!(m.id, format!("{NODE}:solana"));
        assert_eq!(m.pda, PDA);
        assert_eq!(m.agent, AGENT);
        assert_eq!(m.owner, "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb");
        assert!(m.active);
        assert!(m.expiry > 1_788_000_000);
        assert_eq!(m.kind, "create_mandate");
        assert_eq!(m.slot, 495753253);
        assert!(a.actions.is_empty() && a.permissions.is_empty());
    }

    #[test]
    fn add_permission_decodes_caps_and_an_empty_discriminator_list() {
        let a = decode_block(&program(), &block_of(&["add_permission"]));
        assert_eq!(a.permissions.len(), 1);
        let p = &a.permissions[0];
        assert_eq!(p.target, SHOP_ATA);
        assert_eq!(p.per_tx_limit, 2_000_000);
        assert_eq!(p.total_limit, 5_000_000);
        assert_eq!(p.discriminator_size, 1);
        assert!(p.instructions.is_empty());
        assert_eq!(p.mandate_id, PDA);
        assert_eq!(p.kind, "add_permission");
    }

    #[test]
    fn a_landed_payment_is_an_allowed_action_to_the_destination_token_account() {
        let a = decode_block(&program(), &block_of(&["execute_payment_ok"]));
        assert_eq!(a.actions.len(), 1);
        let x = &a.actions[0];
        assert!(x.allowed);
        assert_eq!(x.block_reason, "");
        assert_eq!(x.error_code, 0);
        assert_eq!(x.amount, 1_500_000);
        assert_eq!(x.target, SHOP_ATA);
        assert_eq!(x.agent, AGENT);
        assert_eq!(x.pda, PDA);
        assert_eq!(x.kind, "execute_payment");
        assert_eq!(x.id, format!("{}:0", x.tx_hash));
    }

    #[test]
    fn refused_payments_are_kept_with_the_mandates_reason() {
        let a = decode_block(&program(), &block_of(&["execute_payment_6007", "execute_payment_6008"]));
        assert_eq!(a.actions.len(), 2, "both reverted transactions must be indexed");
        let over_per_tx = &a.actions[0];
        assert!(!over_per_tx.allowed);
        assert_eq!(over_per_tx.error_code, 6007);
        assert_eq!(over_per_tx.error_name, "PerTxLimitExceeded");
        assert_eq!(over_per_tx.block_reason, "OVER_BUDGET");
        assert_eq!(over_per_tx.amount, 2_500_000);
        let over_lifetime = &a.actions[1];
        assert_eq!(over_lifetime.error_code, 6008);
        assert_eq!(over_lifetime.block_reason, "OVER_BUDGET");
        assert_eq!(over_lifetime.amount, 1_000_000);
    }

    #[test]
    fn verify_reports_the_sibling_program_it_was_asked_about() {
        let ok = decode_block(&program(), &block_of(&["verify_ok"]));
        assert_eq!(ok.actions.len(), 1);
        assert!(ok.actions[0].allowed);
        assert_eq!(ok.actions[0].kind, "verify");
        assert_eq!(ok.actions[0].target, SPL_TOKEN, "Transfer + verify: the target is the SPL Token program");
        assert_eq!(ok.actions[0].amount, 500_000);
        assert_eq!(ok.actions[0].id, format!("{}:1", ok.actions[0].tx_hash), "verify was the second instruction");

        let denied = decode_block(&program(), &block_of(&["verify_6006"]));
        assert_eq!(denied.actions.len(), 1);
        let x = &denied.actions[0];
        assert!(!x.allowed);
        assert_eq!(x.error_code, 6006);
        assert_eq!(x.error_name, "InstructionNotAllowed");
        assert_eq!(x.block_reason, "NOT_PERMITTED");
        assert_eq!(x.target, SPL_TOKEN, "SetAuthority + verify: the target is still the SPL Token program");
    }

    #[test]
    fn a_failure_in_another_instruction_is_failed_not_the_mandates_verdict() {
        let mut f = fixture("verify_ok");
        // pretend the sibling Transfer (index 0) failed with InsufficientFunds while verify is at index 1
        f.err = Some(serde_json::json!({ "InstructionError": [0, { "Custom": 1 }] }));
        f.log_messages.clear();
        let block = Block { slot: f.slot, block_time: Some(UnixTimestamp { timestamp: f.block_time }), transactions: vec![confirmed(&f)], ..Default::default() };
        let a = decode_block(&program(), &block);
        assert_eq!(a.actions.len(), 1);
        assert!(!a.actions[0].allowed);
        assert_eq!(a.actions[0].block_reason, "FAILED");
        assert_eq!(a.actions[0].error_code, 0);
    }

    #[test]
    fn the_whole_demo_run_in_one_block() {
        let a = decode_block(&program(), &block_of(&["revoke_mandate", "create_mandate", "add_permission", "execute_payment_ok", "execute_payment_6007", "execute_payment_6008", "verify_ok", "verify_6006"]));
        assert_eq!(a.mandates.iter().filter(|m| m.kind == "revoke_mandate").count(), 1);
        assert_eq!(a.mandates.iter().filter(|m| m.kind == "create_mandate").count(), 1);
        assert_eq!(a.permissions.len(), 1);
        assert_eq!(a.actions.len(), 5);
        let refused: Vec<u32> = a.actions.iter().filter(|x| !x.allowed).map(|x| x.error_code).collect();
        assert_eq!(refused, vec![6007, 6008, 6006]);
        assert!(a.actions.iter().all(|x| x.chain == "solana" && !x.tx_hash.is_empty() && x.pda == PDA));
    }

    #[test]
    fn other_programs_and_empty_data_are_ignored() {
        let mut f = fixture("execute_payment_ok");
        f.instructions[0].data = "1".into(); // zero-length data
        let block = Block { slot: f.slot, block_time: None, transactions: vec![confirmed(&f)], ..Default::default() };
        assert!(decode_block(&program(), &block).actions.is_empty());
        let other = bs58::decode(SPL_TOKEN).into_vec().unwrap();
        assert!(decode_block(&other, &block_of(&["execute_payment_ok"])).actions.is_empty());
    }
}
