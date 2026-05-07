use anchor_lang::prelude::*;

// ============ Constants ============

pub const BPS: u64 = 10_000;
pub const PRECISION: u64 = 1_000_000; // 6 decimals (USDC)
pub const USDC_DECIMALS: u8 = 6;
pub const TOKEN_DECIMALS: u8 = 6;

pub const MAX_PERFORMANCE_FEE_BPS: u64 = 3_000; // 30%
pub const MAX_EXIT_FEE_BPS: u64 = 5_000;        // 50%

// Default BC ratio cap (factory-configurable via global_max_bc_ratio_bps)
// 15_000 = 1.5× stored ratio → ~2× price at Seed tier (90% squared blend)
pub const DEFAULT_MAX_BC_RATIO_BPS: u64 = 15_000;
pub const MAX_BC_RATIO_BPS: u64 = DEFAULT_MAX_BC_RATIO_BPS; // alias

pub const TWAP_HALF_LIFE_DEFAULT: i64 = 600; // 10 minutes

// Default bonding curve virtual depth (EVM-aligned: 2M tokens)
pub const DEFAULT_BC_VIRTUAL_BASE:   u64 = 2_000_000_000_000; // 2M in µtokens
pub const DEFAULT_BC_VIRTUAL_TOKENS: u64 = 2_000_000_000_000;
pub const DEFAULT_INITIAL_ASSETS:    u64 = 100_000_000_000;   // 100k USDC (6 dec)

// Graduation tier thresholds (total_assets in µUSDC)
pub const TIER_SEED_THRESHOLD:       u64 = 100_000_000_000;     // $100K
pub const TIER_GROWTH_THRESHOLD:     u64 = 1_000_000_000_000;   // $1M
pub const TIER_MATURE_THRESHOLD:     u64 = 10_000_000_000_000;  // $10M
pub const TIER_GRADUATED_THRESHOLD:  u64 = 100_000_000_000_000; // $100M

// Graduation tier BC virtual depths (EVM-aligned, µ units)
pub const TIER_SEED_BC:              u64 = 500_000_000_000;     // 500K
pub const TIER_GROWTH_BC:            u64 = 5_000_000_000_000;   // 5M
pub const TIER_MATURE_BC:            u64 = 10_000_000_000_000;  // 10M
pub const TIER_GRADUATED_BC:         u64 = 100_000_000_000_000; // 100M

// Squared ratio blend weights per tier (EVM V38: squaredRatioBps)
// 10_000 = 100% squared (full price² effect, early investor protection)
// 0       = 0% (linear, price tracks NAV closely)
pub const DEFAULT_SQUARED_RATIO_BPS:        u64 = 9_000; // 90% (below Seed)
pub const TIER_SEED_SQUARED_RATIO_BPS:      u64 = 9_000; // 90%
pub const TIER_GROWTH_SQUARED_RATIO_BPS:    u64 = 6_000; // 60%
pub const TIER_MATURE_SQUARED_RATIO_BPS:    u64 = 1_500; // 15%
pub const TIER_GRADUATED_SQUARED_RATIO_BPS: u64 = 200;   // 2%

// Keep old names as aliases to avoid breaking existing references
pub const TIER_1_THRESHOLD: u64 = TIER_SEED_THRESHOLD;
pub const TIER_2_THRESHOLD: u64 = TIER_GROWTH_THRESHOLD;
pub const TIER_3_THRESHOLD: u64 = TIER_MATURE_THRESHOLD;

// ============ Exit Fee Tiers ============

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ExitFeeTier {
    pub min_hold_days: u64,
    pub fee_bps: u64,
}

pub fn default_exit_fee_tiers() -> Vec<ExitFeeTier> {
    vec![
        ExitFeeTier { min_hold_days: 30, fee_bps: 0 },
        ExitFeeTier { min_hold_days: 7,  fee_bps: 300 },
        ExitFeeTier { min_hold_days: 3,  fee_bps: 800 },
        ExitFeeTier { min_hold_days: 0,  fee_bps: 1500 },
    ]
}

// ============ Entry Record ============

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct EntryRecord {
    pub user: Pubkey,
    pub token_amount: u64,
    pub entry_nav: u64,  // PRECISION
    pub acquired_at: i64, // Unix timestamp
}
