use anchor_lang::prelude::*;

use crate::{errors::AgentRailError, state::*};

/// Owner kills the mandate. Anchor's `close` moves the lamports to the owner, reassigns the account to
/// the system program and reallocs it to zero length on exit. The handler zeroes every byte first.
#[derive(Accounts)]
pub struct RevokeMandate<'info> {
    #[account(mut, close = owner)]
    pub mandate: AccountLoader<'info, MandateAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

pub fn handle_revoke_mandate(ctx: Context<RevokeMandate>) -> Result<()> {
    {
        let m = ctx.accounts.mandate.load()?;
        require!(m.owner == ctx.accounts.owner.key().to_bytes(), AgentRailError::Unauthorized);
    }
    // SPEC §9 flaw 6: wipe the data, discriminator included, BEFORE the lamports are drained.
    // A revived account in the same transaction then carries no valid discriminator and no mandate.
    let info = ctx.accounts.mandate.to_account_info();
    let mut data = info.try_borrow_mut_data()?;
    data.fill(0);
    Ok(())
}
