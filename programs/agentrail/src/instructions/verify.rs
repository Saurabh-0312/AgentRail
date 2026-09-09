use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};

use crate::{checks::*, errors::AgentRailError, state::*};

/// The CPI-composable read-side check.
///
/// SPEC §9 flaw 1: the caller never tells AgentRail *which* program or instruction it intends to run.
/// It passes only the index of a sibling instruction in the same transaction; the program id and the
/// instruction data are read from the instructions sysvar, so they are the ones that will execute.
/// For SPL Token instructions that carry an amount, the amount is parsed from that data as well.
/// Programs with unknown argument layouts fall back to `declared_amount`; the permission's discriminator
/// gate still decides whether the instruction may run at all.
#[derive(Accounts)]
pub struct Verify<'info> {
    #[account(mut)]
    pub mandate: AccountLoader<'info, MandateAccount>,
    pub agent: Signer<'info>,
    /// CHECK: pinned to the instructions sysvar address; read only through the checked loaders.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn handle_verify(ctx: Context<Verify>, target_ix_index: u8, declared_amount: u64) -> Result<()> {
    // Cheapest rejections first: one byte, then one i64, then a 32-byte compare.
    let now = Clock::get()?.unix_timestamp;
    let mut m = ctx.accounts.mandate.load_mut()?;
    require_live(&m, now)?;
    require!(m.agent == ctx.accounts.agent.key().to_bytes(), AgentRailError::NotTheAgent);

    // The real instruction, straight from the transaction. Verifying AgentRail itself is meaningless:
    // when called directly that would be this very instruction, and via CPI the top-level
    // instruction belongs to the calling program, which is exactly what should be checked.
    let sysvar = ctx.accounts.instructions_sysvar.to_account_info();
    let target = load_instruction_at_checked(target_ix_index as usize, &sysvar)
        .map_err(|_| AgentRailError::InvalidTargetInstruction)?;
    require!(target.program_id != crate::ID, AgentRailError::InvalidTargetInstruction);

    let idx = find_permission(&m, &target.program_id.to_bytes())
        .ok_or(AgentRailError::ProgramNotAllowed)?;
    let p = &mut m.permissions[idx];
    require!(discriminator_allowed(p, &target.data), AgentRailError::InstructionNotAllowed);

    let amount = spl_token_amount(&target.program_id, &target.data).unwrap_or(declared_amount);
    check_limits(p, amount)?;
    record_spend(p, amount)
}

/// Amount carried by SPL Token / Token-2022 instructions whose layout is `[tag, amount: u64 LE, ..]`:
/// Transfer (3), Approve (4), Burn (8), TransferChecked (12), ApproveChecked (13), BurnChecked (15).
fn spl_token_amount(program_id: &Pubkey, data: &[u8]) -> Option<u64> {
    let is_token = *program_id == anchor_spl::token::ID || *program_id == anchor_spl::token_2022::ID;
    if !is_token || data.len() < 9 {
        return None;
    }
    match data[0] {
        3 | 4 | 8 | 12 | 13 | 15 => Some(u64::from_le_bytes(data[1..9].try_into().ok()?)),
        _ => None,
    }
}
