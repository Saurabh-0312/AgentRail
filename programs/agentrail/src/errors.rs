use anchor_lang::prelude::*;

#[error_code]
pub enum AgentRailError {
    #[msg("mandate is not active")]
    NotActive,
    #[msg("mandate has expired")]
    Expired,
    #[msg("permission list is full (max 16)")]
    PermissionsFull,
    #[msg("no permission entry for this program")]
    PermissionNotFound,
    #[msg("program already has a permission entry")]
    DuplicatePermission,
    #[msg("program is not permitted by the mandate")]
    ProgramNotAllowed,
    #[msg("instruction is not permitted by the mandate")]
    InstructionNotAllowed,
    #[msg("amount exceeds the per-transaction limit")]
    PerTxLimitExceeded,
    #[msg("amount exceeds the lifetime spend limit")]
    SpendLimitExceeded,
    #[msg("signer is not the mandate owner")]
    Unauthorized,
    #[msg("signer is not the mandated agent")]
    NotTheAgent,
    #[msg("discriminator size must be 1, 4 or 8")]
    InvalidDiscriminatorSize,
    #[msg("too many discriminators (max 8)")]
    TooManyDiscriminators,
    #[msg("expiry must be in the future")]
    InvalidExpiry,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("target instruction is out of range or is AgentRail itself")]
    InvalidTargetInstruction,
    #[msg("destination is not on the mandate's allowed list")]
    DestinationNotAllowed,
    #[msg("token account is not owned by the mandate owner")]
    TokenAccountNotOwned,
}
