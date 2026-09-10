//! AgentRail agent-mandate activity on Solana, as Substreams modules.
//!
//!   map_instructions   every AgentRail instruction in the block, successful or reverted
//!   store_mandates     mandate PDA -> ens_node, learned from create_mandate
//!   map_activity       the shared-schema rows, every action joined to its ens_node
//!   graph_out          the same rows as entity changes (indexer/schema.graphql)
//!
//! No events exist and none are needed: instruction data + transaction meta carry everything,
//! including the refusals (see EVENTS.md). `decode` and `errors` are plain Rust and are tested on
//! the host; the handlers only exist in the wasm build.
pub mod decode;
pub mod entity;
pub mod errors;
#[allow(clippy::all)]
pub mod pb;

use std::collections::HashMap;

use crate::pb::agentrail::v1::Activity;
use crate::pb::sf::substreams::sink::entity::v1::EntityChanges;

/// Join every row to its ens_node: `lookup` first (the store), then the params hints, else left
/// empty. The row is still emitted: a payment against an unknown mandate is a fact, not an error.
pub fn join_activity(params: &str, activity: Activity, lookup: impl Fn(&str) -> Option<String>) -> Activity {
    let hints: HashMap<String, String> = decode::mandate_hints(params).into_iter().collect();
    let node_for = |pda: &str| -> String {
        lookup(pda)
            .filter(|n| !n.is_empty())
            .or_else(|| hints.get(pda).cloned())
            .unwrap_or_default()
    };
    let mut out = activity;
    for m in out.mandates.iter_mut() {
        if m.ens_node.is_empty() {
            m.ens_node = node_for(&m.pda);
        }
        if !m.ens_node.is_empty() {
            m.id = decode::mandate_id(&m.ens_node);
        }
    }
    for p in out.permissions.iter_mut() {
        // decode.rs keys permissions by PDA; here they become ens-keyed like every other source
        let pda = p.mandate_id.clone();
        p.ens_node = node_for(&pda);
        if !p.ens_node.is_empty() {
            p.mandate_id = decode::mandate_id(&p.ens_node);
            p.id = format!("{}:{}", p.mandate_id, p.target);
        }
    }
    for a in out.actions.iter_mut() {
        a.ens_node = node_for(&a.pda);
        if !a.ens_node.is_empty() {
            a.mandate_id = decode::mandate_id(&a.ens_node);
        }
    }
    out
}

/// The shared-schema rows as graph-node entity changes. Rows without an ens_node are skipped here
/// (they have no Mandate to hang off) but remain in `map_activity`'s output.
pub fn entity_changes(activity: &Activity) -> EntityChanges {
    let mut c = entity::Changes::new();
    for m in activity.mandates.iter() {
        if m.id.is_empty() {
            continue;
        }
        if m.kind == "revoke_mandate" {
            c.update("Mandate", &m.id).boolean("active", false).bigint("updatedAt", m.timestamp);
            continue;
        }
        c.create("Mandate", &m.id)
            .bytes_hex("ensNode", &m.ens_node)
            .string("chain", &m.chain)
            .bytes_b58("owner", &m.owner)
            .bytes_b58("agent", &m.agent)
            .bigint("expiry", m.expiry)
            .boolean("active", m.active)
            .bigint("createdAt", m.timestamp)
            .bigint("updatedAt", m.timestamp)
            .bytes_b58("txHash", &m.tx_hash);
    }
    for p in activity.permissions.iter() {
        if p.ens_node.is_empty() {
            continue;
        }
        if p.kind == "remove_permission" {
            c.delete("Permission", &p.id);
            continue;
        }
        c.create("Permission", &p.id)
            .string("mandate", &p.mandate_id)
            .bytes_b58("target", &p.target)
            .bytes_hex_array("instructions", &p.instructions)
            .bigint("perTxLimit", p.per_tx_limit)
            .bigint("totalLimit", p.total_limit)
            .bigint("spentTotal", 0u64)
            .string("source", "onchain")
            .string("targetChain", "solana:devnet")
            .bigint("updatedAt", p.timestamp);
    }
    for a in activity.actions.iter() {
        if a.ens_node.is_empty() {
            continue;
        }
        let row = c
            .create("Action", &a.id)
            .string("mandate", &a.mandate_id)
            .string("chain", &a.chain)
            .bigint("timestamp", a.timestamp)
            .bytes_b58("target", &a.target)
            .bigint("amount", a.amount)
            .boolean("allowed", a.allowed)
            .bytes_b58("txHash", &a.tx_hash)
            .string("kind", &a.kind)
            .bytes_b58("agent", &a.agent);
        if !a.allowed {
            row.string("blockReason", &a.block_reason);
            if a.error_code != 0 {
                row.int("errorCode", a.error_code as i32);
            }
        }
    }
    c.finish()
}

#[cfg(target_arch = "wasm32")]
mod handlers {
    use substreams::errors::Error;
    use substreams::prelude::*;
    use substreams::store::{StoreGetString, StoreNew, StoreSetString};
    use substreams_solana::pb::sf::solana::r#type::v1::Block;

    use super::*;

    #[substreams::handlers::map]
    fn map_instructions(params: String, block: Block) -> Result<Activity, Error> {
        let program = decode::program_from_params(&params).map_err(Error::msg)?;
        Ok(decode::decode_block(&program, &block))
    }

    #[substreams::handlers::store]
    fn store_mandates(activity: Activity, store: StoreSetString) {
        for m in activity.mandates.iter().filter(|m| m.kind == "create_mandate" && m.active) {
            store.set(0, &m.pda, &m.ens_node);
        }
    }

    #[substreams::handlers::map]
    fn map_activity(params: String, activity: Activity, mandates: StoreGetString) -> Result<Activity, Error> {
        Ok(join_activity(&params, activity, |pda| mandates.get_last(pda)))
    }

    #[substreams::handlers::map]
    fn graph_out(activity: Activity) -> Result<EntityChanges, Error> {
        Ok(entity_changes(&activity))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::agentrail::v1::{Action, Mandate, Permission};

    const PDA: &str = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";
    const NODE: &str = "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae";

    fn activity() -> Activity {
        Activity {
            mandates: vec![Mandate { pda: PDA.into(), kind: "revoke_mandate".into(), ..Default::default() }],
            permissions: vec![Permission { id: format!("{PDA}:x"), mandate_id: PDA.into(), target: "x".into(), kind: "add_permission".into(), ..Default::default() }],
            actions: vec![
                Action { id: "sig:0".into(), pda: PDA.into(), allowed: false, block_reason: "OVER_BUDGET".into(), error_code: 6007, kind: "execute_payment".into(), ..Default::default() },
                Action { id: "sig:1".into(), pda: "unknownPda".into(), allowed: true, ..Default::default() },
            ],
        }
    }

    #[test]
    fn the_store_joins_rows_to_their_ens_node() {
        let out = join_activity("", activity(), |pda| (pda == PDA).then(|| NODE.to_string()));
        assert_eq!(out.mandates[0].id, format!("{NODE}:solana"));
        assert_eq!(out.permissions[0].mandate_id, format!("{NODE}:solana"));
        assert_eq!(out.permissions[0].id, format!("{NODE}:solana:x"));
        assert_eq!(out.actions[0].mandate_id, format!("{NODE}:solana"));
        assert_eq!(out.actions[0].ens_node, NODE);
        assert_eq!(out.actions[1].ens_node, "", "an unknown mandate is kept, unjoined");
    }

    #[test]
    fn params_hints_fill_the_join_when_the_store_has_no_entry() {
        let params = format!("mandate:{PDA}={NODE}");
        let out = join_activity(&params, activity(), |_| None);
        assert_eq!(out.actions[0].mandate_id, format!("{NODE}:solana"));
        assert_eq!(out.actions[1].mandate_id, "");
    }

    #[test]
    fn entity_changes_carry_the_refusal_and_skip_unjoined_rows() {
        let out = join_activity("", activity(), |pda| (pda == PDA).then(|| NODE.to_string()));
        let changes = entity_changes(&out);
        let entities: Vec<(&str, &str)> = changes.entity_changes.iter().map(|c| (c.entity.as_str(), c.id.as_str())).collect();
        assert_eq!(entities.len(), 3, "revoke update + permission + one joined action; the unjoined action is skipped");
        assert_eq!(entities[0].0, "Mandate");
        assert_eq!(entities[1].0, "Permission");
        assert_eq!(entities[2], ("Action", "sig:0"));
        let action = &changes.entity_changes[2];
        let names: Vec<&str> = action.fields.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"blockReason") && names.contains(&"errorCode") && names.contains(&"allowed"));
    }
}
