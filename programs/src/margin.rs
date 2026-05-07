use anchor_lang::prelude::*;

// ============================================================
// Drift Protocol Constants
// ============================================================

/// Drift V2 Program ID (same on devnet and mainnet)
pub const DRIFT_PROGRAM_ID: &str = "vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P";

/// Drift USDC spot market index
pub const USDC_SPOT_MARKET_INDEX: u16 = 0;

/// Drift perp market indices
pub const SOL_PERP_MARKET: u16 = 0;
pub const BTC_PERP_MARKET: u16 = 1;
pub const ETH_PERP_MARKET: u16 = 2;

/// Drift precision constants
pub const DRIFT_BASE_PRECISION: u64 = 1_000_000_000; // 1e9 for base asset
pub const DRIFT_PRICE_PRECISION: u64 = 1_000_000;    // 1e6 for price (USDC decimals)
pub const DRIFT_QUOTE_PRECISION: u64 = 1_000_000;    // 1e6 USDC

/// Maximum leverage allowed (10x)
pub const MAX_LEVERAGE: u64 = 10;

/// Maximum USDC a leader can allocate to margin (50% of vault)
pub const MAX_MARGIN_ALLOCATION_BPS: u64 = 5_000;

// ============================================================
// Drift Instruction Discriminators (from Drift IDL v2)
// Computed as sha256("global:<ix_name>")[..8]
// Verify against: https://github.com/drift-labs/protocol-v2/blob/master/sdk/src/idl/drift.json
// ============================================================

pub const DRIFT_DEPOSIT_DISC: [u8; 8]           = [242, 35, 198, 137, 82, 225, 242, 182];
pub const DRIFT_WITHDRAW_DISC: [u8; 8]          = [183, 18, 70, 156, 148, 109, 161, 34];
pub const DRIFT_PLACE_PERP_ORDER_DISC: [u8; 8]  = [69, 161, 93, 202, 120, 126, 76, 185];
pub const DRIFT_CANCEL_ORDER_DISC: [u8; 8]      = [95, 129, 237, 240, 8, 49, 223, 132];
pub const DRIFT_SETTLE_PNL_DISC: [u8; 8]        = [43, 61, 234, 45, 15, 95, 152, 153];
pub const DRIFT_INIT_USER_DISC: [u8; 8]         = [111, 17, 185, 250, 60, 122, 38, 254];
pub const DRIFT_INIT_USER_STATS_DISC: [u8; 8]   = [254, 243, 72, 98, 251, 130, 168, 213];

// ============================================================
// Enums
// ============================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PositionDirection {
    Long,
    Short,
}

/// Maps to Drift's OrderType enum
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarginOrderType {
    Market,
    Limit,
}

/// Maps to Drift's PositionDirection for serialization
/// Drift uses 0=Long, 1=Short in its ABI
impl PositionDirection {
    pub fn to_drift_u8(self) -> u8 {
        match self {
            PositionDirection::Long => 0,
            PositionDirection::Short => 1,
        }
    }
}

// ============================================================
// Account: MarginPosition
// PDA seeds: [b"margin", vault, leader, market_index as bytes]
// ============================================================

#[account]
pub struct MarginPosition {
    /// Parent vault
    pub vault: Pubkey,
    /// Leader who opened this position
    pub leader: Pubkey,
    /// Drift User account (sub-account 0 of our TradingVault PDA)
    pub drift_user: Pubkey,
    /// Drift perp market index (0=SOL, 1=BTC, 2=ETH ...)
    pub market_index: u16,
    /// Direction: 0=Long, 1=Short
    pub direction: u8,
    /// Base asset amount in DRIFT_BASE_PRECISION (1e9)
    pub base_asset_amount: u64,
    /// USDC deposited as collateral (6 decimals, from vault.usdc_reserve)
    pub usdc_collateral: u64,
    /// Last known entry price in DRIFT_PRICE_PRECISION (1e6 = 1 USDC)
    pub entry_price: u64,
    /// Unix timestamp when position opened
    pub opened_at: i64,
    /// Drift order ID (for cancellation)
    pub order_id: u32,
    /// Whether position is currently open
    pub is_open: bool,
    /// PDA bump
    pub bump: u8,
}

impl MarginPosition {
    pub const LEN: usize = 8   // discriminator
        + 32  // vault
        + 32  // leader
        + 32  // drift_user
        + 2   // market_index
        + 1   // direction
        + 8   // base_asset_amount
        + 8   // usdc_collateral
        + 8   // entry_price
        + 8   // opened_at
        + 4   // order_id
        + 1   // is_open
        + 1;  // bump

    /// Get market symbol from market_index
    pub fn market_symbol(&self) -> &'static str {
        match self.market_index {
            SOL_PERP_MARKET => "SOL-PERP",
            BTC_PERP_MARKET => "BTC-PERP",
            ETH_PERP_MARKET => "ETH-PERP",
            _ => "UNKNOWN-PERP",
        }
    }

    /// Calculate unrealized P&L given current price (6 decimals)
    /// Returns (pnl, is_profit)
    pub fn calculate_unrealized_pnl(&self, current_price: u64) -> (u64, bool) {
        if !self.is_open || self.entry_price == 0 || self.base_asset_amount == 0 {
            return (0, true);
        }

        // size_usdc = base_asset_amount * current_price / 1e9
        // Using u128 to avoid overflow
        let entry_value = (self.base_asset_amount as u128)
            .saturating_mul(self.entry_price as u128)
            / (DRIFT_BASE_PRECISION as u128);

        let current_value = (self.base_asset_amount as u128)
            .saturating_mul(current_price as u128)
            / (DRIFT_BASE_PRECISION as u128);

        match self.direction {
            0 => {
                // Long: profit if price went up
                if current_value >= entry_value {
                    ((current_value - entry_value) as u64, true)
                } else {
                    ((entry_value - current_value) as u64, false)
                }
            }
            _ => {
                // Short: profit if price went down
                if entry_value >= current_value {
                    ((entry_value - current_value) as u64, true)
                } else {
                    ((current_value - entry_value) as u64, false)
                }
            }
        }
    }
}

// ============================================================
// Account: DriftUserAccount
// Tracks the vault's Drift sub-account (initialized once per vault)
// PDA seeds: [b"drift_account", vault]
// ============================================================

#[account]
pub struct DriftUserAccount {
    /// Parent vault
    pub vault: Pubkey,
    /// The Drift User PDA address (owned by Drift program)
    pub drift_user: Pubkey,
    /// The Drift UserStats PDA address
    pub drift_user_stats: Pubkey,
    /// Total USDC currently deposited in Drift
    pub total_deposited: u64,
    /// Drift sub-account ID (0 by default)
    pub sub_account_id: u16,
    /// PDA bump for our tracking account
    pub bump: u8,
}

impl DriftUserAccount {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 2 + 1;
}

// ============================================================
// Drift CPI Builders
// ============================================================

/// Build Drift deposit instruction data
/// Layout: disc(8) + market_index(2, LE) + amount(8, LE) + reduce_only(1)
pub fn drift_deposit_data(market_index: u16, amount: u64, reduce_only: bool) -> Vec<u8> {
    let mut data = Vec::with_capacity(19);
    data.extend_from_slice(&DRIFT_DEPOSIT_DISC);
    data.extend_from_slice(&market_index.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(if reduce_only { 1 } else { 0 });
    data
}

/// Build Drift withdraw instruction data
/// Layout: disc(8) + market_index(2) + amount(8) + reduce_only(1)
pub fn drift_withdraw_data(market_index: u16, amount: u64, reduce_only: bool) -> Vec<u8> {
    let mut data = Vec::with_capacity(19);
    data.extend_from_slice(&DRIFT_WITHDRAW_DISC);
    data.extend_from_slice(&market_index.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(if reduce_only { 1 } else { 0 });
    data
}

/// Build Drift cancel_order instruction data
/// Layout: disc(8) + order_id(4, LE, wrapped in Option: 1 byte tag + value)
pub fn drift_cancel_order_data(order_id: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity(13);
    data.extend_from_slice(&DRIFT_CANCEL_ORDER_DISC);
    data.push(1u8); // Some tag for Option<u32>
    data.extend_from_slice(&order_id.to_le_bytes());
    data
}

/// Build Drift place_perp_order instruction data.
///
/// OrderParams layout (Drift ABI, must match Drift IDL):
///   order_type: u8      (0=Market, 1=Limit)
///   market_type: u8     (1=Perp)
///   direction: u8       (0=Long, 1=Short)
///   user_order_id: u8
///   base_asset_amount: u64
///   price: u64          (0 for Market)
///   market_index: u16
///   reduce_only: bool
///   post_only: u8       (0=None)
///   immediate_or_cancel: bool
///   max_ts: i64 (Option<i64>: 0 = None)
///   trigger_price: u64 (Option<u64>: 0 = None)
///   trigger_condition: u8
///   oracle_price_offset: i32 (Option<i32>: 0 = None)
///   auction_duration: u8 (Option<u8>)
///   auction_start_price: i64 (Option<i64>)
///   auction_end_price: i64 (Option<i64>)
pub fn drift_place_perp_order_data(
    market_index: u16,
    direction: u8,
    base_asset_amount: u64,
    price: u64,          // 0 for Market orders
    order_type: u8,      // 0=Market, 1=Limit
    reduce_only: bool,
) -> Vec<u8> {
    let mut data = Vec::with_capacity(80);
    data.extend_from_slice(&DRIFT_PLACE_PERP_ORDER_DISC);

    // OrderParams struct:
    data.push(order_type);       // order_type: Market=0
    data.push(1u8);              // market_type: Perp=1
    data.push(direction);        // direction
    data.push(0u8);              // user_order_id
    data.extend_from_slice(&base_asset_amount.to_le_bytes()); // base_asset_amount
    data.extend_from_slice(&price.to_le_bytes());             // price
    data.extend_from_slice(&market_index.to_le_bytes());      // market_index
    data.push(if reduce_only { 1 } else { 0 });  // reduce_only
    data.push(0u8);              // post_only: None
    data.push(0u8);              // immediate_or_cancel: false
    // max_ts: Option<i64> = None
    data.push(0u8);
    data.extend_from_slice(&0i64.to_le_bytes());
    // trigger_price: Option<u64> = None
    data.push(0u8);
    data.extend_from_slice(&0u64.to_le_bytes());
    data.push(0u8);              // trigger_condition
    // oracle_price_offset: Option<i32> = None
    data.push(0u8);
    data.extend_from_slice(&0i32.to_le_bytes());
    // auction_duration: Option<u8> = None
    data.push(0u8);
    data.push(0u8);
    // auction_start_price: Option<i64> = None
    data.push(0u8);
    data.extend_from_slice(&0i64.to_le_bytes());
    // auction_end_price: Option<i64> = None
    data.push(0u8);
    data.extend_from_slice(&0i64.to_le_bytes());

    data
}

/// Build Drift initialize_user instruction data
/// Layout: disc(8) + sub_account_id(2, LE) + name([u8; 32])
pub fn drift_init_user_data(sub_account_id: u16, name: &str) -> Vec<u8> {
    let mut data = Vec::with_capacity(42);
    data.extend_from_slice(&DRIFT_INIT_USER_DISC);
    data.extend_from_slice(&sub_account_id.to_le_bytes());
    // name: [u8; 32]
    let mut name_bytes = [0u8; 32];
    let name_raw = name.as_bytes();
    let copy_len = name_raw.len().min(32);
    name_bytes[..copy_len].copy_from_slice(&name_raw[..copy_len]);
    data.extend_from_slice(&name_bytes);
    data
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct MarginOpenEvent {
    pub vault: Pubkey,
    pub leader: Pubkey,
    pub market_index: u16,
    pub direction: u8,
    pub base_asset_amount: u64,
    pub usdc_collateral: u64,
    pub timestamp: i64,
}

#[event]
pub struct MarginCloseEvent {
    pub vault: Pubkey,
    pub leader: Pubkey,
    pub market_index: u16,
    pub usdc_returned: u64,
    pub pnl: i64,
    pub timestamp: i64,
}

#[event]
pub struct MarginSyncEvent {
    pub vault: Pubkey,
    pub external_assets: u64,
    pub timestamp: i64,
}
