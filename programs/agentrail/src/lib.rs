//! AgentRail: instruction-level authorization for AI agents on Solana.
//!
//! A mandate is an on-chain permission record issued by an owner for one agent. The agent can ask to
//! spend; only this program can sign, as the SPL delegate on the owner's own token account.
//! The agent holds no spending authority of its own.

use anchor_lang::prelude::*;

pub mod checks;
pub mod errors;
pub mod instructions;
pub mod state;

pub use errors::AgentRailError;
pub use instructions::*;
pub use state::*;

declare_id!("GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj");

#[program]
pub mod agentrail {
    use super::*;

    /// Owner issues a mandate for `agent`. PDA: `["mandate", owner, agent]`.
    pub fn create_mandate(ctx: Context<CreateMandate>, ens_node: [u8; 32], expiry: i64) -> Result<()> {
        instructions::create_mandate::handle_create_mandate(ctx, ens_node, expiry)
    }

    /// Owner allows `program_id` with the given instruction discriminators and spend caps.
    pub fn add_permission(
        ctx: Context<MutateMandate>,
        program_id: Pubkey,
        discriminators: Vec<[u8; 8]>,
        discriminator_size: u8,
        spend_limit: u64,
        per_tx_limit: u64,
    ) -> Result<()> {
        instructions::add_permission::handle_add_permission(
            ctx,
            program_id,
            discriminators,
            discriminator_size,
            spend_limit,
            per_tx_limit,
        )
    }

    /// Owner removes the permission entry for `program_id`.
    pub fn remove_permission(ctx: Context<MutateMandate>, program_id: Pubkey) -> Result<()> {
        instructions::remove_permission::handle_remove_permission(ctx, program_id)
    }

    /// Owner kills the mandate: data zeroed, then the account is closed and rent returned.
    pub fn revoke_mandate(ctx: Context<RevokeMandate>) -> Result<()> {
        instructions::revoke_mandate::handle_revoke_mandate(ctx)
    }
}
