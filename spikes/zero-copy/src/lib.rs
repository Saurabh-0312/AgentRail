use anchor_lang::prelude::*;

declare_id!("2L1kQbLu3Do86jBKfihqALrh8vwthNRwPyvi4sCqCP8S");

pub const MAX_PERMISSIONS: usize = 16;

/// 128 bytes. Layout per SPEC 8.2.
#[zero_copy]
pub struct Permission {
    pub program_id: [u8; 32],
    pub spend_limit: u64,
    pub per_tx_limit: u64,
    pub spend_total: u64,
    pub call_count: u32,
    pub discriminators_len: u8,
    pub discriminator_size: u8,
    pub _pad: [u8; 2],
    pub discriminators: [[u8; 8]; 8],
}

/// 120 bytes of fields; +8 Anchor discriminator = 128-byte header. Layout per SPEC 8.2.
#[account(zero_copy)]
pub struct MandateAccount {
    pub active: u8,
    pub bump: u8,
    pub _pad: [u8; 6],
    pub owner: [u8; 32],
    pub agent: [u8; 32],
    pub ens_node: [u8; 32],
    pub expiry: i64,
    pub permissions_len: u16,
    pub _pad2: [u8; 6],
    pub permissions: [Permission; MAX_PERMISSIONS],
}

#[program]
pub mod zero_copy_check {
    use super::*;

    pub fn init_mandate(ctx: Context<InitMandate>, expiry: i64) -> Result<()> {
        let mut m = ctx.accounts.mandate.load_init()?;
        m.active = 1;
        m.bump = ctx.bumps.mandate;
        m.owner = ctx.accounts.owner.key().to_bytes();
        m.expiry = expiry;
        Ok(())
    }

    /// Reads through AccountLoader with no full deserialization and asserts the layout.
    pub fn verify_layout(ctx: Context<VerifyLayout>) -> Result<()> {
        let m = ctx.accounts.mandate.load()?;
        require!(m.active == 1, SpikeError::NotActive);
        msg!(
            "active={} len={} size_of={} perm_size={}",
            m.active,
            m.permissions_len,
            core::mem::size_of::<MandateAccount>(),
            core::mem::size_of::<Permission>()
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitMandate<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + core::mem::size_of::<MandateAccount>(),
        seeds = [b"mandate", owner.key().as_ref()],
        bump
    )]
    pub mandate: AccountLoader<'info, MandateAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyLayout<'info> {
    pub mandate: AccountLoader<'info, MandateAccount>,
}

#[error_code]
pub enum SpikeError {
    #[msg("mandate not active")]
    NotActive,
}
