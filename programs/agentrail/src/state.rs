//! On-chain account layout. SPEC §8.2.
//!
//! Both structs are `zero_copy`: Anchor's macro emits `#[repr(C)]` plus the bytemuck `Pod`/`Zeroable`
//! derives, so every field sits at a fixed, 8-byte-aligned offset and reads go through `AccountLoader`
//! without deserializing the whole account. The tests at the bottom pin every offset to the SPEC table.

use anchor_lang::prelude::*;

/// Maximum programs a single mandate may authorize.
pub const MAX_PERMISSIONS: usize = 16;
/// Maximum instruction discriminators per permission entry.
pub const MAX_DISCRIMINATORS: usize = 8;
/// PDA seed prefix: `[MANDATE_SEED, owner, agent]`.
pub const MANDATE_SEED: &[u8] = b"mandate";
/// Anchor account discriminator size.
pub const ANCHOR_DISCRIMINATOR: usize = 8;
/// Total on-chain account size: 8-byte discriminator + 120-byte header + 16 x 128-byte permissions.
pub const MANDATE_ACCOUNT_SIZE: usize = ANCHOR_DISCRIMINATOR + core::mem::size_of::<MandateAccount>();

/// One authorized program and the instructions the agent may call on it. Exactly 128 bytes.
#[zero_copy]
pub struct Permission {
    /// Target program the agent may call.
    pub program_id: [u8; 32],
    /// Lifetime spend cap in base units. 0 = unlimited.
    pub spend_limit: u64,
    /// Per-transaction spend cap in base units. 0 = unlimited.
    pub per_tx_limit: u64,
    /// Cumulative spend through this permission.
    pub spend_total: u64,
    /// Number of successful calls through this permission.
    pub call_count: u32,
    /// How many entries of `discriminators` are in use (0..=8).
    pub discriminators_len: u8,
    /// Width of each discriminator in bytes: 1 (SPL Token tag), 4 (System Program u32 LE) or 8 (Anchor).
    /// SPEC §9 flaw 2: matching a fixed 8 bytes against a 1-byte-tag program would compare argument data.
    pub discriminator_size: u8,
    pub _pad: [u8; 2],
    /// Allowed instruction discriminators, left-aligned in each 8-byte slot.
    pub discriminators: [[u8; 8]; MAX_DISCRIMINATORS],
}

/// The mandate: what one agent may do on behalf of one owner. 120 bytes of fields; Anchor prepends an
/// 8-byte discriminator, giving the 128-byte header in SPEC §8.2.
#[account(zero_copy)]
pub struct MandateAccount {
    /// 1 = active, 0 = revoked. Read first on the hot path: cheapest possible rejection.
    pub active: u8,
    /// Canonical PDA bump, stored so the hot path never calls `find_program_address` (SPEC §9 flaw 4).
    pub bump: u8,
    pub _pad: [u8; 6],
    /// The human who issued the mandate. Only this key may add/remove permissions or revoke.
    pub owner: [u8; 32],
    /// The agent this mandate authorizes. It can request payments; it can never sign them.
    pub agent: [u8; 32],
    /// ENS namehash of the agent's subname. Join key across chains (SPEC §10.5).
    pub ens_node: [u8; 32],
    /// Unix timestamp after which the mandate is dead. Kept short and renewed (SPEC §10.2).
    pub expiry: i64,
    /// How many entries of `permissions` are in use (0..=16).
    pub permissions_len: u16,
    pub _pad2: [u8; 6],
    pub permissions: [Permission; MAX_PERMISSIONS],
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    use core::mem::{offset_of, size_of};

    /// Struct offsets are relative to the first field; on-chain offsets add the Anchor discriminator.
    const D: usize = ANCHOR_DISCRIMINATOR;

    #[test]
    fn sizes_match_spec() {
        assert_eq!(size_of::<Permission>(), 128, "Permission must be 128 bytes");
        assert_eq!(size_of::<MandateAccount>(), 2168, "MandateAccount fields must be 2168 bytes");
        assert_eq!(MANDATE_ACCOUNT_SIZE, 2176, "on-chain account must be 2176 bytes");
        assert_eq!(core::mem::align_of::<MandateAccount>(), 8);
        assert_eq!(core::mem::align_of::<Permission>(), 8);
    }

    #[test]
    fn mandate_onchain_offsets_match_spec_table() {
        assert_eq!(D + offset_of!(MandateAccount, active), 8);
        assert_eq!(D + offset_of!(MandateAccount, bump), 9);
        assert_eq!(D + offset_of!(MandateAccount, _pad), 10);
        assert_eq!(D + offset_of!(MandateAccount, owner), 16);
        assert_eq!(D + offset_of!(MandateAccount, agent), 48);
        assert_eq!(D + offset_of!(MandateAccount, ens_node), 80);
        assert_eq!(D + offset_of!(MandateAccount, expiry), 112);
        assert_eq!(D + offset_of!(MandateAccount, permissions_len), 120);
        assert_eq!(D + offset_of!(MandateAccount, _pad2), 122);
        assert_eq!(D + offset_of!(MandateAccount, permissions), 128);
    }

    #[test]
    fn permission_offsets_match_spec_table() {
        assert_eq!(offset_of!(Permission, program_id), 0);
        assert_eq!(offset_of!(Permission, spend_limit), 32);
        assert_eq!(offset_of!(Permission, per_tx_limit), 40);
        assert_eq!(offset_of!(Permission, spend_total), 48);
        assert_eq!(offset_of!(Permission, call_count), 56);
        assert_eq!(offset_of!(Permission, discriminators_len), 60);
        assert_eq!(offset_of!(Permission, discriminator_size), 61);
        assert_eq!(offset_of!(Permission, _pad), 62);
        assert_eq!(offset_of!(Permission, discriminators), 64);
    }

    #[test]
    fn permissions_array_is_contiguous_128_byte_stride() {
        let base = offset_of!(MandateAccount, permissions);
        assert_eq!(base, 120);
        assert_eq!(base + MAX_PERMISSIONS * size_of::<Permission>(), size_of::<MandateAccount>());
    }
}
