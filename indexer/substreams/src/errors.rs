//! Why a transaction failed, from the two places the block records it.
//!
//! `meta.err` is the bincode encoding of Solana's `TransactionError`. The variant we care about is
//! `InstructionError(u8, InstructionError)` (tag 8) wrapping `Custom(u32)` (tag 25), which is how
//! an Anchor `#[error_code]` reaches the ledger. Everything else is a runtime failure that was not
//! the mandate's decision. `meta.log_messages` carries the same number in the Anchor log line
//! (`Error Number: 6007`) and is used as a cross-check / fallback.

/// Solana `TransactionError::InstructionError` discriminant (bincode, u32 LE).
const TAG_INSTRUCTION_ERROR: u32 = 8;
/// Solana `InstructionError::Custom` discriminant (bincode, u32 LE).
const TAG_CUSTOM: u32 = 25;

/// The failure of one transaction, as far as the mandate is concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    /// Index of the top-level instruction that failed, when the error names one.
    pub instruction_index: Option<u8>,
    /// The program's own error code (Anchor error number), when the failure was `Custom`.
    pub custom_code: Option<u32>,
}

fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Parse the bincode `TransactionError`. Returns `None` for an empty / unparseable error payload.
pub fn parse_transaction_error(err: &[u8]) -> Option<Failure> {
    let tag = u32_le(err, 0)?;
    if tag != TAG_INSTRUCTION_ERROR {
        return Some(Failure { instruction_index: None, custom_code: None });
    }
    let index = *err.get(4)?;
    let inner = u32_le(err, 5)?;
    let custom_code = if inner == TAG_CUSTOM { u32_le(err, 9) } else { None };
    Some(Failure { instruction_index: Some(index), custom_code })
}

/// Fallback: the Anchor log line `… Error Number: 6007. …`.
pub fn error_number_from_logs<'a>(logs: impl IntoIterator<Item = &'a String>) -> Option<u32> {
    for line in logs {
        if let Some(rest) = line.split("Error Number: ").nth(1) {
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = digits.parse::<u32>() {
                return Some(n);
            }
        }
    }
    None
}

/// The block reasons of the shared schema (SPEC §8.4), plus FAILED for anything that was not the
/// mandate's decision. Never dropped: a landed refusal is the row this index exists for.
pub const OVER_BUDGET: &str = "OVER_BUDGET";
pub const NOT_PERMITTED: &str = "NOT_PERMITTED";
pub const EXPIRED: &str = "EXPIRED";
pub const REVOKED: &str = "REVOKED";
pub const FAILED: &str = "FAILED";

/// Anchor error numbers of `programs/agentrail/src/errors.rs`, in declaration order from 6000.
pub fn error_name(code: u32) -> &'static str {
    match code {
        6000 => "NotActive",
        6001 => "Expired",
        6002 => "PermissionsFull",
        6003 => "PermissionNotFound",
        6004 => "DuplicatePermission",
        6005 => "ProgramNotAllowed",
        6006 => "InstructionNotAllowed",
        6007 => "PerTxLimitExceeded",
        6008 => "SpendLimitExceeded",
        6009 => "Unauthorized",
        6010 => "NotTheAgent",
        6011 => "InvalidDiscriminatorSize",
        6012 => "TooManyDiscriminators",
        6013 => "InvalidExpiry",
        6014 => "Overflow",
        6015 => "InvalidTargetInstruction",
        6016 => "DestinationNotAllowed",
        6017 => "TokenAccountNotOwned",
        _ => "",
    }
}

/// Error number -> `blockReason` (EVENTS.md table).
pub fn block_reason(code: Option<u32>) -> &'static str {
    match code {
        Some(6000) => REVOKED,
        Some(6001) => EXPIRED,
        Some(6007) | Some(6008) => OVER_BUDGET,
        Some(6005) | Some(6006) | Some(6010) | Some(6015) | Some(6016) | Some(6017) => NOT_PERMITTED,
        Some(6009) => NOT_PERMITTED,
        _ => FAILED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// bincode of `TransactionError::InstructionError(index, InstructionError::Custom(code))`.
    pub fn custom_error_bytes(index: u8, code: u32) -> Vec<u8> {
        let mut v = TAG_INSTRUCTION_ERROR.to_le_bytes().to_vec();
        v.push(index);
        v.extend_from_slice(&TAG_CUSTOM.to_le_bytes());
        v.extend_from_slice(&code.to_le_bytes());
        v
    }

    #[test]
    fn custom_anchor_error_is_parsed_with_its_instruction_index() {
        let f = parse_transaction_error(&custom_error_bytes(0, 6007)).unwrap();
        assert_eq!(f, Failure { instruction_index: Some(0), custom_code: Some(6007) });
        let f = parse_transaction_error(&custom_error_bytes(1, 6006)).unwrap();
        assert_eq!(f.instruction_index, Some(1));
        assert_eq!(f.custom_code, Some(6006));
    }

    #[test]
    fn runtime_failures_are_kept_but_carry_no_code() {
        // InstructionError(0, InsufficientFunds) — variant 5, no payload
        let mut v = TAG_INSTRUCTION_ERROR.to_le_bytes().to_vec();
        v.push(0);
        v.extend_from_slice(&5u32.to_le_bytes());
        assert_eq!(parse_transaction_error(&v), Some(Failure { instruction_index: Some(0), custom_code: None }));
        // AccountNotFound — variant 2, not an instruction error
        assert_eq!(parse_transaction_error(&2u32.to_le_bytes()), Some(Failure { instruction_index: None, custom_code: None }));
        assert_eq!(parse_transaction_error(&[]), None);
        assert_eq!(parse_transaction_error(&[8, 0, 0]), None);
    }

    #[test]
    fn anchor_log_line_is_a_fallback_for_the_error_number() {
        let logs = vec![
            "Program GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj invoke [1]".to_string(),
            "Program log: AnchorError thrown in programs\\agentrail\\src\\checks.rs:36. Error Code: PerTxLimitExceeded. Error Number: 6007. Error Message: amount exceeds the per-transaction limit.".to_string(),
        ];
        assert_eq!(error_number_from_logs(&logs), Some(6007));
        assert_eq!(error_number_from_logs(&Vec::<String>::new()), None);
    }

    #[test]
    fn every_error_number_maps_to_a_block_reason_and_the_three_demo_codes_are_right() {
        assert_eq!(block_reason(Some(6006)), NOT_PERMITTED);
        assert_eq!(block_reason(Some(6007)), OVER_BUDGET);
        assert_eq!(block_reason(Some(6008)), OVER_BUDGET);
        assert_eq!(block_reason(Some(6001)), EXPIRED);
        assert_eq!(block_reason(Some(6000)), REVOKED);
        assert_eq!(block_reason(Some(6016)), NOT_PERMITTED);
        assert_eq!(block_reason(None), FAILED);
        assert_eq!(block_reason(Some(1)), FAILED);
        assert_eq!(error_name(6006), "InstructionNotAllowed");
        assert_eq!(error_name(6017), "TokenAccountNotOwned");
        assert_eq!(error_name(7000), "");
    }
}
