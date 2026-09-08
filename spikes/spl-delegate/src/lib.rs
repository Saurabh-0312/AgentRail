use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("Hm6VCXAHfrNQzeWJCC2rWtQzH5JQfadp2UjJRf5nRnzA");

#[program]
pub mod spl_delegate {
    use super::*;

    /// Moves `amount` from `from` to `to` with the program PDA acting as the SPL delegate.
    /// The PDA signs via invoke_signed; the token owner never signs this instruction.
    pub fn delegate_transfer(ctx: Context<DelegateTransfer>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.delegate;
        let seeds: &[&[u8]] = &[b"delegate", &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.delegate.to_account_info(),
                },
                signer,
            ),
            amount,
        )
    }
}

#[derive(Accounts)]
pub struct DelegateTransfer<'info> {
    #[account(mut)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut)]
    pub to: Account<'info, TokenAccount>,
    /// CHECK: program-derived delegate, used only as the CPI signer
    #[account(seeds = [b"delegate"], bump)]
    pub delegate: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}
