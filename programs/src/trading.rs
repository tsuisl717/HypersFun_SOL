use anchor_lang::prelude::*;

/// Trading vault — tracks funds deployed by leader for spot/perp trading
#[account]
pub struct TradingVault {
    pub vault: Pubkey,           // Parent vault
    pub leader: Pubkey,
    pub allocated_usdc: u64,    // USDC extracted for trading
    pub max_allocation_bps: u64, // Max % of vault assets leader can use (BPS)
    pub daily_trade_limit: u64, // Max USDC tradeable per day
    pub trades_today: u64,       // USDC traded today
    pub last_reset_day: i64,    // Unix timestamp of last daily reset
    pub bump: u8,
}

impl TradingVault {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1;
}

/// API wallet authorized to trade on behalf of leader
#[account]
pub struct ApiWallet {
    pub vault: Pubkey,
    pub wallet: Pubkey,
    pub is_active: bool,
    pub bump: u8,
}

impl ApiWallet {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 1;
}

/// Trade authorization ticket (hot potato equivalent)
/// Leader creates → consumed in same TX by trade execution
#[account]
pub struct TradeAuthorization {
    pub vault: Pubkey,
    pub leader: Pubkey,
    pub usdc_amount: u64,
    pub direction: bool,  // true = buy base, false = sell base
    pub expires_at: i64,
    pub bump: u8,
}

impl TradeAuthorization {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 8 + 1;
}
