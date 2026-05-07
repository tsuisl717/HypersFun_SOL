use anchor_lang::prelude::*;
use crate::types::*;

/// Factory — global registry and settings
#[account]
#[derive(Default)]
pub struct Factory {
    pub authority: Pubkey,             // Admin
    pub treasury: Pubkey,              // Fee recipient
    pub creation_fee: u64,             // USDC fee to create a vault
    pub trading_fee_bps: u64,          // Global trading fee (BPS)
    pub vault_count: u64,
    pub global_max_bc_ratio_bps: u64,  // Max stored BC ratio cap (default 15_000 = 1.5×)
    pub bump: u8,
}

impl Factory {
    pub const LEN: usize = 8     // discriminator
        + 32     // authority
        + 32     // treasury
        + 8      // creation_fee
        + 8      // trading_fee_bps
        + 8      // vault_count
        + 8      // global_max_bc_ratio_bps
        + 1;     // bump
}

/// VaultRegistry entry — maps vault pubkey to metadata
#[account]
pub struct VaultEntry {
    pub vault: Pubkey,
    pub leader: Pubkey,
    pub created_at: i64,
    pub bump: u8,
}

impl VaultEntry {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1;
}
