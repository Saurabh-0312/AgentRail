use anchor_lang::prelude::*;

use crate::{errors::AgentRailError, state::*};

/// Owner issues a mandate for one agent. PDA seeds: `["mandate", owner, agent]`.
#[derive(Accounts)]
pub struct CreateMandate<'info> {
    #[account(
        init,
        payer = owner,
        space = MANDATE_ACCOUNT_SIZE,
        seeds = [MANDATE_SEED, owner.key().as_ref(), agent.key().as_ref()],
        bump
    )]
    pub mandate: AccountLoader<'info, MandateAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: the agent is identified by its public key only. It does not sign and need not exist on-chain.
    pub agent: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_mandate(ctx: Context<CreateMandate>, ens_node: [u8; 32], expiry: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(expiry > now, AgentRailError::InvalidExpiry);

    // `init` hands us zero-filled data; `load_init` writes the discriminator on exit.
    let mut m = ctx.accounts.mandate.load_init()?;
    m.active = 1;
    m.bump = ctx.bumps.mandate;
    m.owner = ctx.accounts.owner.key().to_bytes();
    m.agent = ctx.accounts.agent.key().to_bytes();
    m.ens_node = ens_node;
    m.expiry = expiry;
    m.permissions_len = 0;
    Ok(())
}
