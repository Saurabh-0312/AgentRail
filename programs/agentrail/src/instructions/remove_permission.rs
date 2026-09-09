use anchor_lang::prelude::*;
use bytemuck::Zeroable;

use super::add_permission::MutateMandate;
use crate::{errors::AgentRailError, state::*};

/// Swap-remove: O(1), order is irrelevant because every lookup is a linear scan.
pub fn handle_remove_permission(ctx: Context<MutateMandate>, program_id: Pubkey) -> Result<()> {
    let mut m = ctx.accounts.mandate.load_mut()?;
    require!(m.owner == ctx.accounts.owner.key().to_bytes(), AgentRailError::Unauthorized);

    let len = m.permissions_len as usize;
    let target = program_id.to_bytes();
    let idx = (0..len)
        .find(|&i| m.permissions[i].program_id == target)
        .ok_or(AgentRailError::PermissionNotFound)?;

    let last = len - 1;
    if idx != last {
        m.permissions[idx] = m.permissions[last];
    }
    m.permissions[last] = Permission::zeroed();
    m.permissions_len = last as u16;
    Ok(())
}
