//! One file per instruction. Each exports its `#[derive(Accounts)]` context and a `handle_*` function.
//! Glob re-exports are required: Anchor's `#[program]` resolves the generated
//! `__client_accounts_*` / `__cpi_client_accounts_*` modules from the crate root.

pub mod add_permission;
pub mod create_mandate;
pub mod execute_payment;
pub mod remove_permission;
pub mod revoke_mandate;
pub mod verify;

pub use add_permission::*;
pub use create_mandate::*;
pub use execute_payment::*;
pub use remove_permission::*;
pub use revoke_mandate::*;
pub use verify::*;
