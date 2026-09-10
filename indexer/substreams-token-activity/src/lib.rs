//! SPL Token activity on one watched token account (Solana devnet), built from a single prompt with
//! the Substreams SKILLs (`substreams-solana`, `substreams-dev`). See PROMPT.md.
//!
//! One typed protobuf message per instruction; args decoded from `data`, accounts named by layout.
//! `walk_instructions()` visits top-level and inner instructions, so the transfers the AgentRail
//! mandate PDA signs through CPI are attributed like any other.
#[allow(clippy::all)]
pub mod pb;

use substreams::errors::Error;
use substreams_solana::b58;
use substreams_solana::pb::sf::solana::r#type::v1::Block;

use crate::pb::agentrail::token::v1::{Approve, Revoke, TokenActivity, Transfer, TransferChecked};

/// SPL Token program.
const SPL_TOKEN_PROGRAM: [u8; 32] = b58!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// SPL Token instruction discriminators (1-byte tags).
const TRANSFER: u8 = 3;
const APPROVE: u8 = 4;
const REVOKE: u8 = 5;
const TRANSFER_CHECKED: u8 = 12;

/// `account:<token account>;mandate:<authority>` from the module params.
pub fn parse_params(params: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut account = None;
    let mut mandate = None;
    for part in params.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix("account:") {
            account = Some(bs58::decode(v.trim()).into_vec().map_err(|e| format!("bad account {v}: {e}"))?);
        } else if let Some(v) = part.strip_prefix("mandate:") {
            mandate = Some(bs58::decode(v.trim()).into_vec().map_err(|e| format!("bad mandate {v}: {e}"))?);
        }
    }
    Ok((account.ok_or("params must contain account:<base58>")?, mandate.unwrap_or_default()))
}

fn u64_le(data: &[u8], at: usize) -> Option<u64> {
    data.get(at..at + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap()))
}

/// Everything the SPL Token program did with `watched` as the source, in successful transactions.
pub fn token_activity(watched: &[u8], mandate: &[u8], block: &Block) -> TokenActivity {
    let slot = block.slot;
    let mut out = TokenActivity::default();
    for trx in block.transactions() {
        let signature = trx.id();
        for ix in trx.walk_instructions() {
            if ix.program_id().as_ref() != SPL_TOKEN_PROGRAM {
                continue;
            }
            let data = ix.data();
            let Some(&tag) = data.first() else { continue };
            let accounts = ix.accounts();
            // every layout puts the source token account first
            if accounts.first().map(|a| a.as_ref() != watched).unwrap_or(true) {
                continue;
            }
            let inner = !ix.is_root();
            match tag {
                TRANSFER => {
                    // accounts [source, destination, authority] · data [3, amount u64]
                    let (Some(amount), Some(destination), Some(authority)) = (u64_le(data, 1), accounts.get(1), accounts.get(2)) else { continue };
                    out.transfers.push(Transfer {
                        slot,
                        signature: signature.clone(),
                        source: accounts[0].to_string(),
                        destination: destination.to_string(),
                        amount,
                        authority: authority.to_string(),
                        via_mandate: authority.as_ref() == mandate,
                        inner,
                    });
                }
                TRANSFER_CHECKED => {
                    // accounts [source, mint, destination, authority] · data [12, amount u64, decimals u8]
                    let (Some(amount), Some(&decimals), Some(mint), Some(destination), Some(authority)) = (u64_le(data, 1), data.get(9), accounts.get(1), accounts.get(2), accounts.get(3)) else { continue };
                    out.transfer_checkeds.push(TransferChecked {
                        slot,
                        signature: signature.clone(),
                        source: accounts[0].to_string(),
                        mint: mint.to_string(),
                        destination: destination.to_string(),
                        amount,
                        decimals: decimals as u32,
                        authority: authority.to_string(),
                        via_mandate: authority.as_ref() == mandate,
                        inner,
                    });
                }
                APPROVE => {
                    // accounts [source, delegate, owner] · data [4, amount u64]
                    let (Some(amount), Some(delegate), Some(owner)) = (u64_le(data, 1), accounts.get(1), accounts.get(2)) else { continue };
                    out.approves.push(Approve {
                        slot,
                        signature: signature.clone(),
                        source: accounts[0].to_string(),
                        delegate: delegate.to_string(),
                        owner: owner.to_string(),
                        amount,
                        delegate_is_mandate: delegate.as_ref() == mandate,
                    });
                }
                REVOKE => {
                    // accounts [source, owner] · data [5]
                    let Some(owner) = accounts.get(1) else { continue };
                    out.revokes.push(Revoke { slot, signature: signature.clone(), source: accounts[0].to_string(), owner: owner.to_string() });
                }
                _ => {}
            }
        }
    }
    out
}

#[cfg(target_arch = "wasm32")]
mod handlers {
    use super::*;

    #[substreams::handlers::map]
    fn map_token_activity(params: String, block: Block) -> Result<TokenActivity, Error> {
        let (account, mandate) = parse_params(&params).map_err(Error::msg)?;
        Ok(token_activity(&account, &mandate, &block))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_carry_the_watched_account_and_the_mandate() {
        let (a, m) = parse_params("account:AzbPCoBsT4PckeqYMgukhd1u5hhbe48UxBvczVAqdeU9;mandate:7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a").unwrap();
        assert_eq!(a.len(), 32);
        assert_eq!(m.len(), 32);
        assert!(parse_params("mandate:x").is_err());
        assert_eq!(parse_params("account:AzbPCoBsT4PckeqYMgukhd1u5hhbe48UxBvczVAqdeU9").unwrap().1.len(), 0);
    }
}
