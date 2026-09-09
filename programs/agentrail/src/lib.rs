//! AgentRail: instruction-level authorization for AI agents on Solana.
//!
//! A mandate is an on-chain permission record issued by an owner for one agent. The agent can ask to
//! spend; only this program can sign, as the SPL delegate on the owner's own token account.
//! The agent holds no spending authority of its own.

use anchor_lang::prelude::*;

pub mod state;
pub use state::*;

declare_id!("GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj");

#[program]
pub mod agentrail {
    use super::*;
    // Instructions: create_mandate, add_permission, remove_permission, revoke_mandate (lifecycle),
    // verify (read-side check), execute_payment (the gate). Added in the following steps.
}
