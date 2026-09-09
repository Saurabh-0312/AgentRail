use anchor_lang::prelude::*;
use bytemuck::Zeroable;

use crate::{checks::valid_discriminator_size, errors::AgentRailError, state::*};

/// Owner-only mutation of an existing mandate. Shared by `add_permission` and `remove_permission`.
/// The owner is verified against the account's own `owner` field in the handler, so any mandate may be
/// passed and only its issuer can change it. No PDA re-derivation is needed for that guarantee.
#[derive(Accounts)]
pub struct MutateMandate<'info> {
    #[account(mut)]
    pub mandate: AccountLoader<'info, MandateAccount>,
    pub owner: Signer<'info>,
}

pub fn handle_add_permission(
    ctx: Context<MutateMandate>,
    program_id: Pubkey,
    discriminators: Vec<[u8; 8]>,
    discriminator_size: u8,
    spend_limit: u64,
    per_tx_limit: u64,
) -> Result<()> {
    require!(valid_discriminator_size(discriminator_size), AgentRailError::InvalidDiscriminatorSize);
    require!(discriminators.len() <= MAX_DISCRIMINATORS, AgentRailError::TooManyDiscriminators);

    let mut m = ctx.accounts.mandate.load_mut()?;
    require!(m.owner == ctx.accounts.owner.key().to_bytes(), AgentRailError::Unauthorized);

    let len = m.permissions_len as usize;
    require!(len < MAX_PERMISSIONS, AgentRailError::PermissionsFull);
    let target = program_id.to_bytes();
    require!(
        !(0..len).any(|i| m.permissions[i].program_id == target),
        AgentRailError::DuplicatePermission
    );

    let p = &mut m.permissions[len];
    *p = Permission::zeroed();
    p.program_id = target;
    p.spend_limit = spend_limit;
    p.per_tx_limit = per_tx_limit;
    p.discriminators_len = discriminators.len() as u8;
    p.discriminator_size = discriminator_size;
    for (i, d) in discriminators.iter().enumerate() {
        p.discriminators[i] = *d;
    }
    m.permissions_len = (len + 1) as u16;
    Ok(())
}
