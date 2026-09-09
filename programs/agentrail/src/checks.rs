//! Mandate checks shared by `verify` and `execute_payment`. Fail-fast, cheapest first:
//! active byte -> expiry -> program match -> discriminator match -> per-tx limit -> lifetime limit.
//! Everything here reads through the zero-copy view; nothing deserializes the whole account.

use anchor_lang::prelude::*;

use crate::{errors::AgentRailError, state::*};

/// Cheapest rejections first: a single byte, then one i64 compare.
pub fn require_live(m: &MandateAccount, now: i64) -> Result<()> {
    require!(m.active == 1, AgentRailError::NotActive);
    require!(now < m.expiry, AgentRailError::Expired);
    Ok(())
}

/// Linear scan over at most 16 entries. Returns the index of the permission for `program_id`.
pub fn find_permission(m: &MandateAccount, program_id: &[u8; 32]) -> Option<usize> {
    let len = (m.permissions_len as usize).min(MAX_PERMISSIONS);
    (0..len).find(|&i| &m.permissions[i].program_id == program_id)
}

/// True when the first `discriminator_size` bytes of `ix_data` equal one of the allowed discriminators.
/// SPEC §9 flaw 2: the width is per permission (1 for SPL Token, 4 for System, 8 for Anchor), never a fixed 8.
pub fn discriminator_allowed(p: &Permission, ix_data: &[u8]) -> bool {
    let n = p.discriminator_size as usize;
    if !matches!(n, 1 | 4 | 8) || ix_data.len() < n {
        return false;
    }
    let len = (p.discriminators_len as usize).min(MAX_DISCRIMINATORS);
    (0..len).any(|i| p.discriminators[i][..n] == ix_data[..n])
}

/// Per-transaction cap, then lifetime cap. A limit of 0 means unlimited.
pub fn check_limits(p: &Permission, amount: u64) -> Result<()> {
    if p.per_tx_limit != 0 {
        require!(amount <= p.per_tx_limit, AgentRailError::PerTxLimitExceeded);
    }
    if p.spend_limit != 0 {
        let projected = p.spend_total.checked_add(amount).ok_or(AgentRailError::Overflow)?;
        require!(projected <= p.spend_limit, AgentRailError::SpendLimitExceeded);
    }
    Ok(())
}

/// Only called after a transfer succeeded.
pub fn record_spend(p: &mut Permission, amount: u64) -> Result<()> {
    p.spend_total = p.spend_total.checked_add(amount).ok_or(AgentRailError::Overflow)?;
    p.call_count = p.call_count.checked_add(1).ok_or(AgentRailError::Overflow)?;
    Ok(())
}

/// Valid discriminator widths for `add_permission`.
pub fn valid_discriminator_size(n: u8) -> bool {
    matches!(n, 1 | 4 | 8)
}
