use anchor_lang::prelude::*;

declare_id!("GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj");

#[program]
pub mod agentrail {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
