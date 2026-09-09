use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{checks::*, errors::AgentRailError, state::*};

/// The gate. The agent asks; the mandate PDA signs, as the SPL delegate on the owner's own token
/// account. Tokens move straight from `from` to `destination`; there is no vault and the agent holds
/// no authority of its own. The owner sets this up once with `spl-token approve <from> <mandate>`.
///
/// Permission lookup for a payment is keyed by the destination token account: an entry whose
/// `program_id` slot holds `destination` carries that destination's caps. The instruction AgentRail
/// signs is always SPL `Transfer`, so no discriminator gate applies here.
///
/// SPEC §9 flaw 3: caps are in raw units of the mint held by `from`. One mandate, one asset.
/// SPEC §9 flaw 4: no `find_program_address`; the stored bump signs and the owner bytes are compared.
#[derive(Accounts)]
pub struct ExecutePayment<'info> {
    #[account(mut)]
    pub mandate: AccountLoader<'info, MandateAccount>,
    pub agent: Signer<'info>,
    #[account(mut)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_execute_payment(ctx: Context<ExecutePayment>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let destination = ctx.accounts.destination.key().to_bytes();

    // Check under a shared borrow, then release it: the CPI below borrows the mandate as signer.
    let (owner, agent, bump, idx) = {
        let m = ctx.accounts.mandate.load()?;
        require_live(&m, now)?;
        require!(m.agent == ctx.accounts.agent.key().to_bytes(), AgentRailError::NotTheAgent);
        require!(ctx.accounts.from.owner.to_bytes() == m.owner, AgentRailError::TokenAccountNotOwned);
        let idx = find_permission(&m, &destination).ok_or(AgentRailError::DestinationNotAllowed)?;
        check_limits(&m.permissions[idx], amount)?;
        (m.owner, m.agent, m.bump, idx)
    };

    let seeds: &[&[u8]] = &[MANDATE_SEED, &owner, &agent, &[bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.mandate.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    // Only reached when the transfer succeeded.
    let mut m = ctx.accounts.mandate.load_mut()?;
    record_spend(&mut m.permissions[idx], amount)
}
