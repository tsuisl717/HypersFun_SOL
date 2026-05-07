use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

pub mod errors;
pub mod factory;
pub mod margin;
pub mod math;
pub mod trading;
pub mod types;
pub mod vault;

use errors::*;
use factory::*;
use margin::*;
use types::*;
use vault::*;
use trading::*;

declare_id!("5jmoeSiY3kyFhaipuiV1Six4sAwMetsEWNNCTBdfrEza");

/// Compute real-time external_assets from remaining_accounts.
/// Expects pairs of [MarginPosition PDA, Pyth oracle account].
/// If oracle read fails for any position, that position uses stored collateral (no P&L).
/// Falls back to `stored_external` if no remaining_accounts are provided.
fn get_realtime_external(remaining: &[AccountInfo], stored_external: u64) -> u64 {
    if remaining.is_empty() {
        return stored_external;
    }
    let mut total: i64 = 0;
    let mut i = 0;
    while i + 1 < remaining.len() {
        let pos_info  = &remaining[i];
        let ora_info  = &remaining[i + 1];
        i += 2;

        // Deserialize MarginPosition
        let pos_data = match pos_info.try_borrow_data() {
            Ok(d) => d,
            Err(_) => continue,
        };
        let pos = match MarginPosition::try_deserialize(&mut pos_data.as_ref()) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !pos.is_open { continue; }

        // Read oracle price (µUSDC). On any error, use entry_price (P&L = 0).
        let current_price: u64 = ora_info.try_borrow_data()
            .ok()
            .and_then(|d| math::read_pyth_price_usdc(&d).ok())
            .unwrap_or(pos.entry_price);

        // unrealized P&L = base × (current - entry) / BASE_PRECISION (1e9)
        // direction 0 = Long, 1 = Short
        let price_diff = current_price as i64 - pos.entry_price as i64;
        let raw_pnl = (pos.base_asset_amount as i128 * price_diff as i128 / 1_000_000_000) as i64;
        let pnl = if pos.direction == 0 { raw_pnl } else { -raw_pnl };

        let pos_value = (pos.usdc_collateral as i64 + pnl).max(0);
        total += pos_value;
    }
    if total > 0 { total as u64 } else { stored_external }
}

#[program]
pub mod hypersfun {
    use super::*;

    // ============================================================
    // Factory
    // ============================================================

    pub fn initialize_factory(
        ctx: Context<InitializeFactory>,
        creation_fee: u64,
        trading_fee_bps: u64,
        global_max_bc_ratio_bps: u64,
    ) -> Result<()> {
        require!(trading_fee_bps <= BPS / 10, HypersfunError::InvalidFee); // max 10%
        let factory = &mut ctx.accounts.factory;
        factory.authority = ctx.accounts.authority.key();
        factory.treasury = ctx.accounts.treasury.key();
        factory.creation_fee = creation_fee;
        factory.trading_fee_bps = trading_fee_bps;
        factory.vault_count = 0;
        factory.global_max_bc_ratio_bps = if global_max_bc_ratio_bps > 0 {
            global_max_bc_ratio_bps
        } else {
            DEFAULT_MAX_BC_RATIO_BPS
        };
        factory.bump = ctx.bumps.factory;
        Ok(())
    }

    /// Migrate existing factory to new layout (adds global_max_bc_ratio_bps).
    /// Call once after upgrade if factory account was created with old struct.
    pub fn migrate_factory(ctx: Context<MigrateFactory>) -> Result<()> {
        let factory = &mut ctx.accounts.factory;
        if factory.global_max_bc_ratio_bps == 0 {
            factory.global_max_bc_ratio_bps = DEFAULT_MAX_BC_RATIO_BPS;
        }
        Ok(())
    }

    /// Update factory BC ratio cap (admin only).
    pub fn set_factory_bc_ratio(ctx: Context<AdminAction>, global_max_bc_ratio_bps: u64) -> Result<()> {
        require!(global_max_bc_ratio_bps >= BPS, HypersfunError::InvalidFee);       // min 1.0×
        require!(global_max_bc_ratio_bps <= BPS * 10, HypersfunError::InvalidFee);  // max 10×
        ctx.accounts.factory.global_max_bc_ratio_bps = global_max_bc_ratio_bps;
        Ok(())
    }

    // ============================================================
    // Vault
    // ============================================================

    pub fn create_vault(
        ctx: Context<CreateVault>,
        name: String,
        symbol: String,
        metadata_uri: String,
        performance_fee_bps: u64,
    ) -> Result<()> {
        require!(name.len() <= 32, HypersfunError::AmountTooSmall);
        require!(symbol.len() <= 8, HypersfunError::AmountTooSmall);
        require!(
            performance_fee_bps <= MAX_PERFORMANCE_FEE_BPS,
            HypersfunError::InvalidFee
        );

        let vault = &mut ctx.accounts.vault;
        vault.leader = ctx.accounts.leader.key();
        vault.name = name;
        vault.symbol = symbol;
        vault.metadata_uri = metadata_uri;
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.usdc_reserve = 0;
        vault.total_supply = 0;
        vault.total_volume = 0;
        vault.external_assets = 0;
        vault.performance_fee_bps = performance_fee_bps;
        vault.bc_virtual_base = DEFAULT_BC_VIRTUAL_BASE;
        vault.bc_virtual_tokens = DEFAULT_BC_VIRTUAL_TOKENS;
        vault.twap_nav = PRECISION;
        vault.twap_last_updated = Clock::get()?.unix_timestamp;
        vault.twap_half_life = TWAP_HALF_LIFE_DEFAULT;
        vault.is_paused = false;
        vault.factory = ctx.accounts.factory.key();
        vault.bump = ctx.bumps.vault;
        vault.usdc_vault_bump = ctx.bumps.usdc_vault;

        // Register in factory
        let factory = &mut ctx.accounts.factory;
        factory.vault_count += 1;

        Ok(())
    }

    pub fn buy(ctx: Context<Buy>, usdc_amount: u64, min_tokens_out: u64) -> Result<()> {
        require!(usdc_amount > 0, HypersfunError::ZeroAmount);
        require!(!ctx.accounts.vault.is_paused, HypersfunError::VaultPaused);

        // Capture token_mint key before borrowing vault mutably
        let token_mint_key = ctx.accounts.token_mint.key();
        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        // Real-time external assets (includes unrealized Drift P&L via oracle)
        let real_ext = get_realtime_external(ctx.remaining_accounts, vault.external_assets);

        // Capture NAV *before* buy for BC update (entry price)
        let entry_nav = vault.get_nav_realtime(real_ext)?;

        // Calculate tokens out via bonding curve (using real-time NAV)
        let (tokens_out, _price) = vault.get_buy_price_realtime(usdc_amount, real_ext)?;
        require!(tokens_out >= min_tokens_out, HypersfunError::SlippageExceeded);
        require!(tokens_out > 0, HypersfunError::AmountTooSmall);

        // Transfer USDC from user to vault USDC account
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.usdc_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            usdc_amount,
        )?;

        // Mint vault tokens to user
        // Vault PDA seeds: [b"vault", token_mint.key()]
        let vault_bump = vault.bump;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: vault.to_account_info(),
                },
                &[&[b"vault", token_mint_key.as_ref(), &[vault_bump]]],
            ),
            tokens_out,
        )?;

        // Update vault state
        vault.usdc_reserve = vault.usdc_reserve.checked_add(usdc_amount)
            .ok_or(HypersfunError::MathOverflow)?;
        vault.total_supply = vault.total_supply.checked_add(tokens_out)
            .ok_or(HypersfunError::MathOverflow)?;
        vault.total_volume = vault.total_volume.saturating_add(usdc_amount);

        // Update bonding curve virtual reserves (pump effect)
        let max_bc_ratio_bps = ctx.accounts.factory.global_max_bc_ratio_bps.max(BPS);
        vault.update_bc_after_buy(usdc_amount, tokens_out, entry_nav, max_bc_ratio_bps)?;

        // Update TWAP NAV
        let instant_nav = vault.get_nav()?;
        vault.twap_nav = math::calculate_twap_nav(
            instant_nav,
            vault.twap_nav,
            vault.twap_last_updated,
            clock.unix_timestamp,
            vault.twap_half_life,
        );
        vault.twap_last_updated = clock.unix_timestamp;

        // Update/create user share record
        let share = &mut ctx.accounts.user_share;
        if share.amount == 0 {
            share.vault = vault.key();
            share.user = ctx.accounts.user.key();
            share.entry_nav = instant_nav;
            share.acquired_at = clock.unix_timestamp;
            share.bump = ctx.bumps.user_share;
        }
        share.amount = share.amount.checked_add(tokens_out)
            .ok_or(HypersfunError::MathOverflow)?;

        emit!(BuyEvent {
            vault: vault.key(),
            user: ctx.accounts.user.key(),
            usdc_in: usdc_amount,
            tokens_out,
            nav: instant_nav,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn sell(ctx: Context<Sell>, token_amount: u64, min_usdc_out: u64) -> Result<()> {
        require!(token_amount > 0, HypersfunError::ZeroAmount);
        require!(!ctx.accounts.vault.is_paused, HypersfunError::VaultPaused);

        let share = &mut ctx.accounts.user_share;
        require!(share.amount >= token_amount, HypersfunError::InsufficientTokens);

        // Capture token_mint key before borrowing vault mutably
        let token_mint_key = ctx.accounts.vault.token_mint;
        let vault = &mut ctx.accounts.vault;
        let vault_bump = vault.bump;
        let clock = Clock::get()?;

        // Real-time external assets (includes unrealized Drift P&L via oracle)
        let real_ext = get_realtime_external(ctx.remaining_accounts, vault.external_assets);

        // Capture NAV *before* sell for BC update
        let pre_sell_nav = vault.get_nav_realtime(real_ext)?;

        // Calculate USDC out via bonding curve, capped at vault reserves (solvency)
        // EVM: grossAmount capped at availableLiquidity before fee calculation
        let theoretical_usdc = vault.get_sell_price_realtime(token_amount, real_ext)?;
        let gross_usdc = theoretical_usdc.min(vault.usdc_reserve);

        // Exit fee stays in vault (increases NAV for remaining holders — same as EVM)
        let exit_fee_bps = share.get_exit_fee_bps(clock.unix_timestamp);
        let exit_fee = math::mul_div(gross_usdc, exit_fee_bps, BPS)?;
        let after_exit_fee = gross_usdc.saturating_sub(exit_fee);

        // Trading fee applied to after-exit-fee amount, goes to treasury (EVM: cascading fees)
        let factory = &ctx.accounts.factory;
        let trading_fee = math::mul_div(after_exit_fee, factory.trading_fee_bps, BPS)?;

        // Performance fee: correct formula = tokens × (nav - entry_nav) / PRECISION × fee_bps / BPS
        // Paid as token mint to leader in EVM — stored here for event, token mint is TODO
        let perf_fee = if pre_sell_nav > share.entry_nav {
            let profit_per_token = pre_sell_nav - share.entry_nav;
            let total_profit = math::mul_div(token_amount, profit_per_token, PRECISION)?;
            math::mul_div(total_profit, vault.performance_fee_bps, BPS)?
        } else { 0 };

        let net_usdc = after_exit_fee.saturating_sub(trading_fee);

        require!(net_usdc >= min_usdc_out, HypersfunError::SlippageExceeded);
        require!(gross_usdc <= vault.usdc_reserve, HypersfunError::InsufficientUsdc);

        // Burn vault tokens from user
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    from: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            token_amount,
        )?;

        // Transfer USDC to user from vault
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: vault.to_account_info(),
                },
                &[&[b"vault", token_mint_key.as_ref(), &[vault_bump]]],
            ),
            net_usdc,
        )?;

        // Transfer trading fee to treasury only (exit_fee stays in vault — increases NAV)
        if trading_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.usdc_vault.to_account_info(),
                        to: ctx.accounts.treasury_usdc.to_account_info(),
                        authority: vault.to_account_info(),
                    },
                    &[&[b"vault", token_mint_key.as_ref(), &[vault_bump]]],
                ),
                trading_fee,
            )?;
        }

        // Update vault state
        // exit_fee stays in vault → only deduct after_exit_fee (net_usdc + trading_fee)
        vault.usdc_reserve = vault.usdc_reserve.saturating_sub(after_exit_fee);
        vault.total_supply = vault.total_supply.saturating_sub(token_amount);
        vault.total_volume = vault.total_volume.saturating_add(gross_usdc);

        // Update bonding curve virtual reserves (exit fee stays → NAV increase for holders)
        let max_bc_ratio_bps = ctx.accounts.factory.global_max_bc_ratio_bps.max(BPS);
        vault.update_bc_after_sell(token_amount, gross_usdc, exit_fee, pre_sell_nav, max_bc_ratio_bps)?;

        // Update TWAP
        let instant_nav = vault.get_nav()?;
        vault.twap_nav = math::calculate_twap_nav(
            instant_nav,
            vault.twap_nav,
            vault.twap_last_updated,
            clock.unix_timestamp,
            vault.twap_half_life,
        );
        vault.twap_last_updated = clock.unix_timestamp;

        // Update share record
        share.amount = share.amount.saturating_sub(token_amount);

        emit!(SellEvent {
            vault: vault.key(),
            user: ctx.accounts.user.key(),
            tokens_in: token_amount,
            usdc_out: net_usdc,
            exit_fee,
            perf_fee,
            nav: instant_nav,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    // ============================================================
    // Leader Trading
    // ============================================================

    pub fn create_trading_vault(ctx: Context<CreateTradingVault>, max_allocation_bps: u64, daily_limit: u64) -> Result<()> {
        require!(max_allocation_bps <= 5000, HypersfunError::InvalidFee); // max 50%
        let tv = &mut ctx.accounts.trading_vault;
        tv.vault = ctx.accounts.vault.key();
        tv.leader = ctx.accounts.leader.key();
        tv.allocated_usdc = 0;
        tv.max_allocation_bps = max_allocation_bps;
        tv.daily_trade_limit = daily_limit;
        tv.trades_today = 0;
        tv.last_reset_day = Clock::get()?.unix_timestamp / 86400;
        tv.bump = ctx.bumps.trading_vault;
        Ok(())
    }

    pub fn add_api_wallet(ctx: Context<AddApiWallet>) -> Result<()> {
        require!(
            ctx.accounts.vault.leader == ctx.accounts.leader.key(),
            HypersfunError::NotLeader
        );
        let api = &mut ctx.accounts.api_wallet;
        api.vault = ctx.accounts.vault.key();
        api.wallet = ctx.accounts.wallet.key();
        api.is_active = true;
        api.bump = ctx.bumps.api_wallet;
        Ok(())
    }

    // ============================================================
    // Admin
    // ============================================================

    pub fn set_paused(ctx: Context<AdminAction>, paused: bool) -> Result<()> {
        ctx.accounts.vault.is_paused = paused;
        Ok(())
    }

    pub fn update_metadata(ctx: Context<LeaderAction>, metadata_uri: String) -> Result<()> {
        ctx.accounts.vault.metadata_uri = metadata_uri;
        Ok(())
    }

    /// Reset bonding curve virtual reserves to default equal values.
    /// Use when stored bc state is corrupted. Only callable by vault leader.
    pub fn reset_bc(ctx: Context<LeaderAction>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.bc_virtual_base   = DEFAULT_BC_VIRTUAL_BASE;
        vault.bc_virtual_tokens = DEFAULT_BC_VIRTUAL_TOKENS;
        Ok(())
    }

    // ============================================================
    // Margin Trading — Drift Protocol CPI
    // ============================================================

    /// Step 1: Initialize a Drift sub-account for this vault's trading.
    /// Must be called once before any margin operations.
    /// Creates Drift User + UserStats accounts via CPI.
    pub fn init_drift_account(ctx: Context<InitDriftAccount>) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(
            vault.leader == ctx.accounts.leader.key(),
            HypersfunError::NotLeader
        );

        // Record the drift accounts in our tracking struct
        let dua = &mut ctx.accounts.drift_user_account;
        dua.vault = vault.key();
        dua.drift_user = ctx.accounts.drift_user.key();
        dua.drift_user_stats = ctx.accounts.drift_user_stats.key();
        dua.total_deposited = 0;
        dua.sub_account_id = 0;
        dua.bump = ctx.bumps.drift_user_account;

        // CPI: Initialize Drift UserStats (once per authority)
        let init_stats_data = DRIFT_INIT_USER_STATS_DISC.to_vec();
        let init_stats_ix = Instruction {
            program_id: ctx.accounts.drift_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.drift_user_stats.key(), false),
                AccountMeta::new(ctx.accounts.drift_state.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
                AccountMeta::new(ctx.accounts.leader.key(), true),
                AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
                AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            ],
            data: init_stats_data,
        };

        let token_mint_key = vault.token_mint;
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            token_mint_key.as_ref(),
            &[vault.bump],
        ];

        invoke_signed(
            &init_stats_ix,
            &[
                ctx.accounts.drift_user_stats.to_account_info(),
                ctx.accounts.drift_state.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.leader.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[vault_seeds],
        ).map_err(|_| error!(HypersfunError::DriftCpiFailed))?;

        // CPI: Initialize Drift User (sub-account 0)
        let init_user_data = drift_init_user_data(0, "hypersfun");
        let init_user_ix = Instruction {
            program_id: ctx.accounts.drift_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.drift_user.key(), false),
                AccountMeta::new(ctx.accounts.drift_user_stats.key(), false),
                AccountMeta::new(ctx.accounts.drift_state.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
                AccountMeta::new(ctx.accounts.leader.key(), true),
                AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
                AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            ],
            data: init_user_data,
        };

        invoke_signed(
            &init_user_ix,
            &[
                ctx.accounts.drift_user.to_account_info(),
                ctx.accounts.drift_user_stats.to_account_info(),
                ctx.accounts.drift_state.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.leader.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[vault_seeds],
        ).map_err(|_| error!(HypersfunError::DriftCpiFailed))?;

        msg!("Drift account initialized for vault {}", vault.key());
        Ok(())
    }

    /// Step 2: Open a perpetual position on Drift.
    /// Flow: validate → transfer USDC vault→drift_vault → Drift deposit CPI → Drift place_order CPI
    ///
    /// Arguments:
    ///   market_index — 0=SOL-PERP, 1=BTC-PERP, 2=ETH-PERP
    ///   direction    — 0=Long, 1=Short
    ///   usdc_collateral — USDC to use as margin (6 decimals)
    ///   leverage_bps    — Target leverage in BPS (e.g. 20000 = 2x)
    pub fn open_margin_position(
        ctx: Context<OpenMarginPosition>,
        market_index: u16,
        direction: u8,
        usdc_collateral: u64,
        leverage_bps: u64,
        oracle_price_usdc: u64, // current oracle price in DRIFT_PRICE_PRECISION (1e6 = $1)
    ) -> Result<()> {
        require!(usdc_collateral > 0, HypersfunError::ZeroAmount);
        require!(direction <= 1, HypersfunError::InvalidMarketIndex);
        require!(leverage_bps >= 10_000, HypersfunError::AmountTooSmall); // min 1x
        require!(
            leverage_bps <= MAX_LEVERAGE * 10_000,
            HypersfunError::LeverageExceeded
        );
        require!(oracle_price_usdc > 0, HypersfunError::ZeroAmount);

        let vault = &mut ctx.accounts.vault;
        require!(!vault.is_paused, HypersfunError::VaultPaused);
        require!(
            vault.leader == ctx.accounts.leader.key(),
            HypersfunError::NotLeader
        );

        // Check allocation limit (max 50% of vault assets)
        let total_assets = vault.get_total_assets();
        let max_alloc = math::mul_div(total_assets, MAX_MARGIN_ALLOCATION_BPS, types::BPS)?;
        require!(usdc_collateral <= max_alloc, HypersfunError::MarginAllocationExceeded);
        require!(usdc_collateral <= vault.usdc_reserve, HypersfunError::InsufficientUsdc);

        // Position must not already be open for this market
        let pos = &mut ctx.accounts.margin_position;
        require!(!pos.is_open, HypersfunError::PositionAlreadyOpen);

        // base_asset_amount (1e9) = notional_usdc (1e6) * DRIFT_BASE_PRECISION / oracle_price_usdc (1e6)
        // = usdc_collateral * leverage_bps / 10_000 * 1e9 / oracle_price_usdc
        let notional_usdc = math::mul_div(usdc_collateral, leverage_bps, 10_000)?;
        let base_asset_amount = math::mul_div(
            notional_usdc,
            DRIFT_BASE_PRECISION,
            oracle_price_usdc,
        )?;

        let clock = Clock::get()?;

        // Vault seeds (vault PDA signs the Drift CPIs)
        let token_mint_key = vault.token_mint;
        let usdc_vault_seeds: &[&[u8]] = &[
            b"vault",
            token_mint_key.as_ref(),
            &[vault.bump],
        ];

        // CPI: Drift deposit — Drift handles the token transfer internally.
        // remaining_accounts order: [oracle (OracleMap first), spot_market (SpotMarketMap), mint]
        let deposit_data = drift_deposit_data(USDC_SPOT_MARKET_INDEX, usdc_collateral, false);
        let deposit_ix = Instruction {
            program_id: ctx.accounts.drift_program.key(),
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.drift_state.key(), false),
                AccountMeta::new(ctx.accounts.drift_user.key(), false),
                AccountMeta::new(ctx.accounts.drift_user_stats.key(), false),
                AccountMeta::new_readonly(vault.key(), true),
                AccountMeta::new(ctx.accounts.drift_spot_vault.key(), false),
                AccountMeta::new(ctx.accounts.usdc_vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                // remaining_accounts: oracle FIRST (OracleMap), then spot_market (SpotMarketMap), then mint
                AccountMeta::new_readonly(ctx.accounts.usdc_oracle.key(), false),
                AccountMeta::new(ctx.accounts.usdc_spot_market.key(), false),
                AccountMeta::new_readonly(ctx.accounts.usdc_mint.key(), false),
            ],
            data: deposit_data,
        };

        invoke_signed(
            &deposit_ix,
            &[
                ctx.accounts.drift_state.to_account_info(),
                ctx.accounts.drift_user.to_account_info(),
                ctx.accounts.drift_user_stats.to_account_info(),
                vault.to_account_info(),
                ctx.accounts.drift_spot_vault.to_account_info(),
                ctx.accounts.usdc_vault.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.usdc_oracle.to_account_info(),
                ctx.accounts.usdc_spot_market.to_account_info(),
                ctx.accounts.usdc_mint.to_account_info(),
            ],
            &[usdc_vault_seeds],
        ).map_err(|_| error!(HypersfunError::DriftCpiFailed))?;

        // CPI: Drift place_perp_order (Market order)
        // remaining_accounts order: [oracle (OracleMap first), perp_market (PerpMarketMap)]
        let order_data = drift_place_perp_order_data(
            market_index,
            direction,
            base_asset_amount,
            0,     // price=0 → Market order
            0,     // order_type=0 → Market
            false, // reduce_only: false for opening
        );
        let order_ix = Instruction {
            program_id: ctx.accounts.drift_program.key(),
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.drift_state.key(), false),
                AccountMeta::new(ctx.accounts.drift_user.key(), false),
                AccountMeta::new_readonly(vault.key(), true),
                // remaining_accounts: oracles FIRST (OracleMap), then spot markets (SpotMarketMap), then perp markets (PerpMarketMap)
                AccountMeta::new_readonly(ctx.accounts.usdc_oracle.key(), false),
                AccountMeta::new_readonly(ctx.accounts.perp_oracle.key(), false),
                AccountMeta::new_readonly(ctx.accounts.usdc_spot_market.key(), false),
                AccountMeta::new(ctx.accounts.perp_market.key(), false),
            ],
            data: order_data,
        };

        invoke_signed(
            &order_ix,
            &[
                ctx.accounts.drift_state.to_account_info(),
                ctx.accounts.drift_user.to_account_info(),
                vault.to_account_info(),
                ctx.accounts.usdc_oracle.to_account_info(),
                ctx.accounts.perp_oracle.to_account_info(),
                ctx.accounts.usdc_spot_market.to_account_info(),
                ctx.accounts.perp_market.to_account_info(),
            ],
            &[usdc_vault_seeds],
        ).map_err(|_| error!(HypersfunError::DriftCpiFailed))?;

        // Update vault state — USDC moved out of reserve → tracked as external_assets
        vault.usdc_reserve = vault.usdc_reserve.saturating_sub(usdc_collateral);
        vault.external_assets = vault.external_assets.saturating_add(usdc_collateral);

        // Record position
        pos.vault = vault.key();
        pos.leader = ctx.accounts.leader.key();
        pos.drift_user = ctx.accounts.drift_user.key();
        pos.market_index = market_index;
        pos.direction = direction;
        pos.base_asset_amount = base_asset_amount;
        pos.usdc_collateral = usdc_collateral;
        pos.entry_price = 0; // updated by sync_margin_pnl after fill
        pos.opened_at = clock.unix_timestamp;
        pos.order_id = 0;    // updated after on-chain fill
        pos.is_open = true;
        pos.bump = ctx.bumps.margin_position;

        emit!(MarginOpenEvent {
            vault: vault.key(),
            leader: ctx.accounts.leader.key(),
            market_index,
            direction,
            base_asset_amount,
            usdc_collateral,
            timestamp: clock.unix_timestamp,
        });

        msg!("Opened {} {} position: {} USDC collateral, {}x leverage",
            if direction == 0 { "Long" } else { "Short" },
            pos.market_symbol(),
            usdc_collateral,
            leverage_bps / 10_000,
        );

        Ok(())
    }

    /// Step 3a: Place a reverse reduce_only order to close the perp position on Drift.
    ///
    /// This sends an opposite-direction Market order to Drift with reduce_only=true.
    /// On devnet the order may go to auction (up to 180 slots) before filling.
    /// Call withdraw_drift_usdc AFTER the order fills (when Drift shows 0 open position).
    ///
    /// Flow: [cancel pending open order if any] → place reverse reduce_only Market order
    pub fn close_margin_position(
        ctx: Context<CloseMarginPosition>,
    ) -> Result<()> {
        let pos = &mut ctx.accounts.margin_position;
        require!(pos.is_open, HypersfunError::NoOpenPosition);
        require!(
            ctx.accounts.vault.leader == ctx.accounts.leader.key(),
            HypersfunError::NotLeader
        );

        let vault = &ctx.accounts.vault;
        let token_mint_key = vault.token_mint;
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            token_mint_key.as_ref(),
            &[vault.bump],
        ];

        // CPI: Drift cancel_order (if there's a pending open order, cancel it first)
        if pos.order_id > 0 {
            let cancel_data = drift_cancel_order_data(pos.order_id);
            let cancel_ix = Instruction {
                program_id: ctx.accounts.drift_program.key(),
                accounts: vec![
                    AccountMeta::new_readonly(ctx.accounts.drift_state.key(), false),
                    AccountMeta::new(ctx.accounts.drift_user.key(), false),
                    AccountMeta::new_readonly(vault.key(), true),
                ],
                data: cancel_data,
            };
            // Ignore error — order may already be filled
            let _ = invoke_signed(
                &cancel_ix,
                &[
                    ctx.accounts.drift_state.to_account_info(),
                    ctx.accounts.drift_user.to_account_info(),
                    vault.to_account_info(),
                ],
                &[vault_seeds],
            );
        }

        // CPI: Drift place_perp_order (reduce_only, opposite direction) to close the position
        let close_direction = if pos.direction == 0 { 1u8 } else { 0u8 };
        let close_order_data = drift_place_perp_order_data(
            pos.market_index,
            close_direction,
            pos.base_asset_amount,
            0,    // price=0 → Market order
            0,    // order_type=0 → Market
            true, // reduce_only: true — will only close, not reverse
        );
        let close_order_ix = Instruction {
            program_id: ctx.accounts.drift_program.key(),
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.drift_state.key(), false),
                AccountMeta::new(ctx.accounts.drift_user.key(), false),
                AccountMeta::new_readonly(vault.key(), true),
                // OracleMap first, SpotMarketMap, PerpMarketMap
                AccountMeta::new_readonly(ctx.accounts.usdc_oracle.key(), false),
                AccountMeta::new_readonly(ctx.accounts.perp_oracle.key(), false),
                AccountMeta::new_readonly(ctx.accounts.usdc_spot_market.key(), false),
                AccountMeta::new(ctx.accounts.perp_market.key(), false),
            ],
            data: close_order_data,
        };
        invoke_signed(
            &close_order_ix,
            &[
                ctx.accounts.drift_state.to_account_info(),
                ctx.accounts.drift_user.to_account_info(),
                vault.to_account_info(),
                ctx.accounts.usdc_oracle.to_account_info(),
                ctx.accounts.perp_oracle.to_account_info(),
                ctx.accounts.usdc_spot_market.to_account_info(),
                ctx.accounts.perp_market.to_account_info(),
            ],
            &[vault_seeds],
        ).map_err(|_| error!(HypersfunError::DriftCpiFailed))?;

        // Mark position as pending-close (is_open = false).
        // USDC is still in Drift's spot vault; call withdraw_drift_usdc after order fills.
        pos.is_open = false;

        msg!("Close order placed for {} position ({}). Call withdraw_drift_usdc after order fills.",
            pos.market_symbol(),
            if pos.direction == 0 { "Long" } else { "Short" }
        );

        Ok(())
    }

    /// Step 3b: Withdraw USDC from Drift back to the vault after the position is closed.
    ///
    /// Call this AFTER the close order from close_margin_position has filled.
    /// Drift requires a valid oracle when withdrawing with open perp positions, so
    /// this must be called AFTER the perp position is fully closed (zero base asset).
    ///
    /// Arguments:
    ///   withdraw_amount — USDC to withdraw (in 6-decimal units); use pos.usdc_collateral
    ///   min_usdc_out — slippage floor (typically 0 for testing)
    pub fn withdraw_drift_usdc(
        ctx: Context<WithdrawDriftUsdc>,
        withdraw_amount: u64,
        min_usdc_out: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.vault.leader == ctx.accounts.leader.key(),
            HypersfunError::NotLeader
        );

        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;
        let token_mint_key = vault.token_mint;
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            token_mint_key.as_ref(),
            &[vault.bump],
        ];

        // CPI: Drift withdraw
        // remaining_accounts must always include perp_market + perp_oracle in case
        // the close order hasn't filled yet (Drift needs them for margin calc).
        // Once position is fully closed (base_asset = 0), Drift ignores them.
        let withdraw_data = drift_withdraw_data(USDC_SPOT_MARKET_INDEX, withdraw_amount, false);
        let withdraw_ix = Instruction {
            program_id: ctx.accounts.drift_program.key(),
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.drift_state.key(), false),
                AccountMeta::new(ctx.accounts.drift_user.key(), false),
                AccountMeta::new(ctx.accounts.drift_user_stats.key(), false),
                AccountMeta::new_readonly(vault.key(), true),
                AccountMeta::new(ctx.accounts.drift_spot_vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.drift_signer.key(), false),
                AccountMeta::new(ctx.accounts.usdc_vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                // OracleMap: USDC oracle + perp oracle
                AccountMeta::new_readonly(ctx.accounts.usdc_oracle.key(), false),
                AccountMeta::new_readonly(ctx.accounts.perp_oracle.key(), false),
                // SpotMarketMap: USDC spot market (writable)
                AccountMeta::new(ctx.accounts.usdc_spot_market.key(), false),
                // PerpMarketMap: perp market (needed for margin calc if position still exists)
                AccountMeta::new_readonly(ctx.accounts.perp_market.key(), false),
                // Mint
                AccountMeta::new_readonly(ctx.accounts.usdc_mint.key(), false),
            ],
            data: withdraw_data,
        };

        invoke_signed(
            &withdraw_ix,
            &[
                ctx.accounts.drift_state.to_account_info(),
                ctx.accounts.drift_user.to_account_info(),
                ctx.accounts.drift_user_stats.to_account_info(),
                vault.to_account_info(),
                ctx.accounts.drift_spot_vault.to_account_info(),
                ctx.accounts.drift_signer.to_account_info(),
                ctx.accounts.usdc_vault.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.usdc_oracle.to_account_info(),
                ctx.accounts.perp_oracle.to_account_info(),
                ctx.accounts.usdc_spot_market.to_account_info(),
                ctx.accounts.perp_market.to_account_info(),
                ctx.accounts.usdc_mint.to_account_info(),
            ],
            &[vault_seeds],
        ).map_err(|_| error!(HypersfunError::DriftCpiFailed))?;

        let usdc_returned = ctx.accounts.usdc_vault.amount;
        require!(usdc_returned >= min_usdc_out, HypersfunError::SlippageExceeded);

        let pnl: i64 = (usdc_returned as i64).saturating_sub(withdraw_amount as i64);

        // Update vault: external_assets -= withdrawn collateral, usdc_reserve += returned
        vault.external_assets = vault.external_assets.saturating_sub(withdraw_amount);
        vault.usdc_reserve = vault.usdc_reserve.saturating_add(usdc_returned);

        let instant_nav = vault.get_nav()?;
        vault.twap_nav = math::calculate_twap_nav(
            instant_nav,
            vault.twap_nav,
            vault.twap_last_updated,
            clock.unix_timestamp,
            vault.twap_half_life,
        );
        vault.twap_last_updated = clock.unix_timestamp;

        emit!(MarginCloseEvent {
            vault: vault.key(),
            leader: ctx.accounts.leader.key(),
            market_index: 0, // can't access margin_position here; caller knows the market
            usdc_returned,
            pnl,
            timestamp: clock.unix_timestamp,
        });

        msg!("withdraw_drift_usdc: {} USDC returned, PnL: {}", usdc_returned, pnl);

        Ok(())
    }

    /// Update vault's external_assets based on current Drift position value.
    /// Called periodically by leader or automation to keep NAV accurate.
    /// Since we can't read Drift position value on-chain cheaply,
    /// the leader provides the current mark price (from oracle/UI).
    ///
    /// Arguments:
    ///   current_price_usdc — current oracle price in DRIFT_PRICE_PRECISION (1e6)
    pub fn sync_margin_pnl(
        ctx: Context<SyncMarginPnl>,
        current_price_usdc: u64,
    ) -> Result<()> {
        let pos = &ctx.accounts.margin_position;
        require!(pos.is_open, HypersfunError::NoOpenPosition);
        require!(
            ctx.accounts.vault.leader == ctx.accounts.leader.key(),
            HypersfunError::NotLeader
        );

        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        // Calculate position current value
        // value = base_asset_amount * price / DRIFT_BASE_PRECISION
        let position_value = (pos.base_asset_amount as u128)
            .saturating_mul(current_price_usdc as u128)
            / (DRIFT_BASE_PRECISION as u128);

        // Unrealized P&L vs collateral
        let new_external = match pos.direction {
            0 => {
                // Long: value increases with price
                pos.usdc_collateral.saturating_add(
                    (position_value as u64).saturating_sub(
                        math::mul_div(pos.base_asset_amount, pos.entry_price, DRIFT_BASE_PRECISION)
                            .unwrap_or(pos.usdc_collateral)
                    )
                )
            }
            _ => {
                // Short: value decreases with price
                let entry_value = math::mul_div(pos.base_asset_amount, pos.entry_price, DRIFT_BASE_PRECISION)
                    .unwrap_or(pos.usdc_collateral);
                if entry_value > position_value as u64 {
                    pos.usdc_collateral.saturating_add(entry_value - position_value as u64)
                } else {
                    pos.usdc_collateral.saturating_sub(position_value as u64 - entry_value)
                }
            }
        };

        vault.external_assets = new_external;

        // Update TWAP
        let instant_nav = vault.get_nav()?;
        vault.twap_nav = math::calculate_twap_nav(
            instant_nav,
            vault.twap_nav,
            vault.twap_last_updated,
            clock.unix_timestamp,
            vault.twap_half_life,
        );
        vault.twap_last_updated = clock.unix_timestamp;

        emit!(MarginSyncEvent {
            vault: vault.key(),
            external_assets: new_external,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }
}

// ============================================================
// Account Contexts
// ============================================================

#[derive(Accounts)]
pub struct InitializeFactory<'info> {
    #[account(
        init,
        payer = authority,
        space = Factory::LEN,
        seeds = [b"factory"],
        bump,
    )]
    pub factory: Account<'info, Factory>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Treasury wallet
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(name: String, symbol: String)]
pub struct CreateVault<'info> {
    #[account(
        init,
        payer = leader,
        space = Vault::LEN,
        seeds = [b"vault", token_mint.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    /// Vault token mint (SPL Token)
    #[account(
        init,
        payer = leader,
        mint::decimals = types::TOKEN_DECIMALS,
        mint::authority = vault,
    )]
    pub token_mint: Account<'info, Mint>,

    /// USDC reserve token account (PDA)
    #[account(
        init,
        payer = leader,
        token::mint = usdc_mint,
        token::authority = vault,
        seeds = [b"usdc_vault", vault.key().as_ref()],
        bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(mut)]
    pub factory: Account<'info, Factory>,

    #[account(mut)]
    pub leader: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut, seeds = [b"vault", vault.token_mint.as_ref()], bump = vault.bump)]
    pub vault: Box<Account<'info, Vault>>,

    #[account(mut)]
    pub token_mint: Account<'info, Mint>,

    #[account(mut, seeds = [b"usdc_vault", vault.key().as_ref()], bump = vault.usdc_vault_bump)]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = VaultShare::LEN,
        seeds = [b"share", vault.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_share: Box<Account<'info, VaultShare>>,

    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = token_mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub factory: Box<Account<'info, Factory>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut, seeds = [b"vault", vault.token_mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub token_mint: Account<'info, Mint>,

    #[account(mut, seeds = [b"usdc_vault", vault.key().as_ref()], bump = vault.usdc_vault_bump)]
    pub usdc_vault: Account<'info, TokenAccount>,

    #[account(mut, seeds = [b"share", vault.key().as_ref(), user.key().as_ref()], bump = user_share.bump)]
    pub user_share: Account<'info, VaultShare>,

    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub treasury_usdc: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub factory: Account<'info, Factory>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateTradingVault<'info> {
    #[account(
        init,
        payer = leader,
        space = TradingVault::LEN,
        seeds = [b"trading", vault.key().as_ref()],
        bump,
    )]
    pub trading_vault: Account<'info, TradingVault>,

    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub leader: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddApiWallet<'info> {
    #[account(
        init,
        payer = leader,
        space = ApiWallet::LEN,
        seeds = [b"api_wallet", vault.key().as_ref(), wallet.key().as_ref()],
        bump,
    )]
    pub api_wallet: Account<'info, ApiWallet>,

    pub vault: Account<'info, Vault>,
    /// CHECK: New API wallet address
    pub wallet: AccountInfo<'info>,

    #[account(mut)]
    pub leader: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(mut, has_one = factory)]
    pub vault: Account<'info, Vault>,
    #[account(constraint = factory.authority == authority.key() @ HypersfunError::NotAuthorized)]
    pub factory: Account<'info, Factory>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct MigrateFactory<'info> {
    #[account(
        mut,
        realloc = Factory::LEN,
        realloc::payer = authority,
        realloc::zero = false,
        seeds = [b"factory"],
        bump,
        constraint = factory.authority == authority.key() @ HypersfunError::NotAuthorized
    )]
    pub factory: Account<'info, Factory>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LeaderAction<'info> {
    #[account(mut, constraint = vault.leader == leader.key() @ HypersfunError::NotLeader)]
    pub vault: Account<'info, Vault>,
    pub leader: Signer<'info>,
}

// ============================================================
// Margin Account Contexts
// ============================================================

/// Drift Program ID constant (for account constraint validation)
pub const DRIFT_PROGRAM_PUBKEY: anchor_lang::prelude::Pubkey =
    anchor_lang::solana_program::pubkey!("vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P");

#[derive(Accounts)]
pub struct InitDriftAccount<'info> {
    #[account(mut, constraint = vault.leader == leader.key() @ HypersfunError::NotLeader)]
    pub vault: Account<'info, Vault>,

    /// Our tracking account for this vault's Drift user
    #[account(
        init,
        payer = leader,
        space = DriftUserAccount::LEN,
        seeds = [b"drift_account", vault.key().as_ref()],
        bump,
    )]
    pub drift_user_account: Account<'info, DriftUserAccount>,

    /// CHECK: Drift User PDA (created by Drift program via CPI)
    /// seeds: [b"user", vault.key, sub_account_id(2 bytes LE)] on Drift program
    #[account(mut)]
    pub drift_user: UncheckedAccount<'info>,

    /// CHECK: Drift UserStats PDA (created by Drift program via CPI)
    /// seeds: [b"user_stats", vault.key] on Drift program
    #[account(mut)]
    pub drift_user_stats: UncheckedAccount<'info>,

    /// CHECK: Drift global state account
    #[account(mut)]
    pub drift_state: UncheckedAccount<'info>,

    /// CHECK: Drift program
    #[account(constraint = drift_program.key() == DRIFT_PROGRAM_PUBKEY @ HypersfunError::NotAuthorized)]
    pub drift_program: UncheckedAccount<'info>,

    #[account(mut)]
    pub leader: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct OpenMarginPosition<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
        constraint = vault.leader == leader.key() @ HypersfunError::NotLeader,
    )]
    pub vault: Account<'info, Vault>,

    /// USDC reserve of the vault (funds go FROM here into Drift)
    #[account(
        mut,
        seeds = [b"usdc_vault", vault.key().as_ref()],
        bump = vault.usdc_vault_bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// Position tracking account (PDA, one per market per vault)
    #[account(
        init_if_needed,
        payer = leader,
        space = MarginPosition::LEN,
        seeds = [b"margin", vault.key().as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub margin_position: Account<'info, MarginPosition>,

    /// CHECK: Drift User account for this vault
    #[account(mut)]
    pub drift_user: UncheckedAccount<'info>,

    /// CHECK: Drift UserStats
    #[account(mut)]
    pub drift_user_stats: UncheckedAccount<'info>,

    /// CHECK: Drift global state
    #[account(mut)]
    pub drift_state: UncheckedAccount<'info>,

    /// CHECK: Drift USDC spot market vault (tokens transferred here during deposit)
    #[account(mut)]
    pub drift_spot_vault: UncheckedAccount<'info>,

    /// CHECK: Drift USDC spot market account (writable - Drift updates interest)
    #[account(mut)]
    pub usdc_spot_market: UncheckedAccount<'info>,

    /// CHECK: Drift perp market account (writable - Drift updates funding)
    #[account(mut)]
    pub perp_market: UncheckedAccount<'info>,

    /// CHECK: USDC oracle (PythLazerOracle for USDC spot market — passed first to OracleMap)
    pub usdc_oracle: UncheckedAccount<'info>,

    /// CHECK: USDC mint (required as last remaining_account in Drift deposit)
    pub usdc_mint: UncheckedAccount<'info>,

    /// CHECK: Price oracle for the perp market (PythLazerOracle — passed first to OracleMap in order CPI)
    pub perp_oracle: UncheckedAccount<'info>,

    /// CHECK: Drift program
    #[account(constraint = drift_program.key() == DRIFT_PROGRAM_PUBKEY @ HypersfunError::NotAuthorized)]
    pub drift_program: UncheckedAccount<'info>,

    #[account(mut)]
    pub leader: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseMarginPosition<'info> {
    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
        constraint = vault.leader == leader.key() @ HypersfunError::NotLeader,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"margin", vault.key().as_ref(), margin_position.market_index.to_le_bytes().as_ref()],
        bump = margin_position.bump,
        constraint = margin_position.vault == vault.key() @ HypersfunError::NotAuthorized,
    )]
    pub margin_position: Account<'info, MarginPosition>,

    /// CHECK: Drift User account
    #[account(mut)]
    pub drift_user: UncheckedAccount<'info>,

    /// CHECK: Drift global state (readonly — only needed for CPI call)
    pub drift_state: UncheckedAccount<'info>,

    /// CHECK: Drift USDC spot market (readonly for OracleMap/SpotMarketMap in place_perp_order)
    pub usdc_spot_market: UncheckedAccount<'info>,

    /// CHECK: Drift perp market (writable for place_perp_order)
    #[account(mut)]
    pub perp_market: UncheckedAccount<'info>,

    /// CHECK: USDC oracle
    pub usdc_oracle: UncheckedAccount<'info>,

    /// CHECK: Perp oracle (SOL/BTC/ETH oracle for the perp market)
    pub perp_oracle: UncheckedAccount<'info>,

    /// CHECK: Drift program
    #[account(constraint = drift_program.key() == DRIFT_PROGRAM_PUBKEY @ HypersfunError::NotAuthorized)]
    pub drift_program: UncheckedAccount<'info>,

    #[account(mut)]
    pub leader: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawDriftUsdc<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
        constraint = vault.leader == leader.key() @ HypersfunError::NotLeader,
    )]
    pub vault: Account<'info, Vault>,

    /// USDC reserve (tokens returned HERE from Drift withdraw)
    #[account(
        mut,
        seeds = [b"usdc_vault", vault.key().as_ref()],
        bump = vault.usdc_vault_bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// CHECK: Drift User account
    #[account(mut)]
    pub drift_user: UncheckedAccount<'info>,

    /// CHECK: Drift UserStats
    #[account(mut)]
    pub drift_user_stats: UncheckedAccount<'info>,

    /// CHECK: Drift global state
    pub drift_state: UncheckedAccount<'info>,

    /// CHECK: Drift USDC spot market vault (tokens withdrawn from here)
    #[account(mut)]
    pub drift_spot_vault: UncheckedAccount<'info>,

    /// CHECK: Drift signer PDA
    pub drift_signer: UncheckedAccount<'info>,

    /// CHECK: Drift USDC spot market (writable for withdraw)
    #[account(mut)]
    pub usdc_spot_market: UncheckedAccount<'info>,

    /// CHECK: USDC oracle
    pub usdc_oracle: UncheckedAccount<'info>,

    /// CHECK: Perp oracle (for margin calc if close order not yet filled)
    pub perp_oracle: UncheckedAccount<'info>,

    /// CHECK: Perp market (for margin calc if close order not yet filled)
    pub perp_market: UncheckedAccount<'info>,

    /// CHECK: USDC mint
    pub usdc_mint: UncheckedAccount<'info>,

    /// CHECK: Drift program
    #[account(constraint = drift_program.key() == DRIFT_PROGRAM_PUBKEY @ HypersfunError::NotAuthorized)]
    pub drift_program: UncheckedAccount<'info>,

    #[account(mut)]
    pub leader: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncMarginPnl<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
        constraint = vault.leader == leader.key() @ HypersfunError::NotLeader,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [b"margin", vault.key().as_ref(), margin_position.market_index.to_le_bytes().as_ref()],
        bump = margin_position.bump,
        constraint = margin_position.vault == vault.key() @ HypersfunError::NotAuthorized,
    )]
    pub margin_position: Account<'info, MarginPosition>,

    pub leader: Signer<'info>,
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct BuyEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub usdc_in: u64,
    pub tokens_out: u64,
    pub nav: u64,
    pub timestamp: i64,
}

#[event]
pub struct SellEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub tokens_in: u64,
    pub usdc_out: u64,
    pub exit_fee: u64,
    pub perf_fee: u64,
    pub nav: u64,
    pub timestamp: i64,
}
