use anchor_lang::prelude::*;

#[error_code]
pub enum HypersfunError {
    // Factory errors
    #[msg("Vault already registered")]
    VaultAlreadyRegistered,
    #[msg("Vault not found")]
    VaultNotFound,
    #[msg("Invalid fee: exceeds maximum")]
    InvalidFee,
    #[msg("Insufficient creation fee")]
    InsufficientCreationFee,

    // Vault errors
    #[msg("Vault is paused")]
    VaultPaused,
    #[msg("Insufficient USDC amount")]
    InsufficientUsdc,
    #[msg("Insufficient tokens to sell")]
    InsufficientTokens,
    #[msg("Amount too small")]
    AmountTooSmall,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("Zero supply: cannot calculate NAV")]
    ZeroSupply,
    #[msg("Zero amount")]
    ZeroAmount,

    // Trading errors
    #[msg("Not the leader")]
    NotLeader,
    #[msg("Not authorized")]
    NotAuthorized,
    #[msg("Trade limit exceeded")]
    TradeLimitExceeded,
    #[msg("Unauthorized API wallet")]
    UnauthorizedApiWallet,

    // Math errors
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Division by zero")]
    DivisionByZero,

    // Exit fee errors
    #[msg("Holding period too short")]
    HoldingPeriodTooShort,

    // Margin errors
    #[msg("Position already open")]
    PositionAlreadyOpen,
    #[msg("No open position")]
    NoOpenPosition,
    #[msg("Margin allocation exceeds maximum")]
    MarginAllocationExceeded,
    #[msg("Leverage exceeds maximum (10x)")]
    LeverageExceeded,
    #[msg("Drift CPI failed")]
    DriftCpiFailed,
    #[msg("Invalid market index")]
    InvalidMarketIndex,
    #[msg("Drift account not initialized")]
    DriftAccountNotInitialized,
    #[msg("Invalid oracle account or stale price")]
    InvalidOracle,
}
