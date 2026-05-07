use anchor_lang::prelude::*;
use crate::types::*;

/// Core Vault account — bonding curve AMM state
#[account]
pub struct Vault {
    pub leader: Pubkey,
    pub name: String,           // max 32 chars
    pub symbol: String,         // max 8 chars
    pub metadata_uri: String,   // IPFS/Arweave URI, max 200 chars
    pub token_mint: Pubkey,     // SPL Token mint for vault shares
    pub usdc_reserve: u64,      // USDC held in vault (6 decimals)
    pub total_supply: u64,      // Vault token supply (6 decimals)
    pub total_volume: u64,      // Cumulative USDC volume
    pub external_assets: u64,   // Assets deployed to trading (tracked externally)
    pub performance_fee_bps: u64, // Performance fee (max 30%)
    pub bc_virtual_base: u64,   // Bonding curve virtual base
    pub bc_virtual_tokens: u64, // Bonding curve virtual tokens
    pub twap_nav: u64,          // TWAP smoothed NAV (PRECISION)
    pub twap_last_updated: i64, // Timestamp of last TWAP update
    pub twap_half_life: i64,    // TWAP half-life in seconds
    pub is_paused: bool,
    pub factory: Pubkey,        // Parent factory
    pub bump: u8,
    pub usdc_vault_bump: u8,    // USDC token account PDA bump
}

impl Vault {
    pub const LEN: usize = 8       // discriminator
        + 32     // leader
        + 4 + 32 // name
        + 4 + 8  // symbol
        + 4 + 200 // metadata_uri
        + 32     // token_mint
        + 8      // usdc_reserve
        + 8      // total_supply
        + 8      // total_volume
        + 8      // external_assets
        + 8      // performance_fee_bps
        + 8      // bc_virtual_base
        + 8      // bc_virtual_tokens
        + 8      // twap_nav
        + 8      // twap_last_updated
        + 8      // twap_half_life
        + 1      // is_paused
        + 32     // factory
        + 1      // bump
        + 1;     // usdc_vault_bump

    pub fn get_total_assets(&self) -> u64 {
        self.usdc_reserve.saturating_add(self.external_assets)
    }

    pub fn get_nav(&self) -> Result<u64> {
        crate::math::calculate_nav(self.get_total_assets(), self.total_supply)
    }

    /// NAV using real-time external_assets (from oracle, not stored value).
    pub fn get_nav_realtime(&self, real_external: u64) -> Result<u64> {
        let total = self.usdc_reserve.saturating_add(real_external);
        crate::math::calculate_nav(total, self.total_supply)
    }

    /// Buy price using real-time external_assets for NAV calculation.
    pub fn get_buy_price_realtime(&self, usdc_in: u64, real_external: u64) -> Result<(u64, u64)> {
        let total_assets = self.usdc_reserve.saturating_add(real_external);
        let nav = crate::math::calculate_nav(total_assets, self.total_supply)?;
        let (eff_base, eff_tokens) = crate::math::get_effective_virtuals(
            total_assets, self.bc_virtual_base, self.bc_virtual_tokens
        );
        let vb_usdc = ((eff_base as u128).saturating_mul(nav as u128) / PRECISION as u128) as u64;
        let tokens_out = crate::math::calculate_tokens_out(vb_usdc, eff_tokens, usdc_in)?;
        let price = if tokens_out > 0 {
            crate::math::mul_div(usdc_in, PRECISION, tokens_out)?
        } else { 0 };
        Ok((tokens_out, price))
    }

    /// Sell price using real-time external_assets for NAV calculation.
    pub fn get_sell_price_realtime(&self, tokens_in: u64, real_external: u64) -> Result<u64> {
        let total_assets = self.usdc_reserve.saturating_add(real_external);
        let nav = crate::math::calculate_nav(total_assets, self.total_supply)?;
        let (eff_base, eff_tokens) = crate::math::get_effective_virtuals(
            total_assets, self.bc_virtual_base, self.bc_virtual_tokens
        );
        let vb_usdc = ((eff_base as u128).saturating_mul(nav as u128) / PRECISION as u128) as u64;
        crate::math::calculate_usdc_out(vb_usdc, eff_tokens, tokens_in)
    }

    /// Get effective virtual reserves and NAV-adjusted virtual base USDC.
    /// virtualBaseUsdc = effBase × nav / PRECISION
    fn get_eff_and_vb_usdc(&self) -> Result<(u64, u64, u64)> {
        let total_assets = self.get_total_assets();
        let nav = self.get_nav()?;
        let (eff_base, eff_tokens) = crate::math::get_effective_virtuals(
            total_assets, self.bc_virtual_base, self.bc_virtual_tokens
        );
        // vb_usdc = eff_base × nav / PRECISION (u128 intermediate)
        let vb_usdc = ((eff_base as u128)
            .saturating_mul(nav as u128)
            / PRECISION as u128) as u64;
        Ok((eff_base, eff_tokens, vb_usdc))
    }

    pub fn get_buy_price(&self, usdc_in: u64) -> Result<(u64, u64)> {
        let (_eff_base, eff_tokens, vb_usdc) = self.get_eff_and_vb_usdc()?;
        // tokensOut = effTokens × usdc_in / (vbUsdc + usdc_in)
        let tokens_out = crate::math::calculate_tokens_out(vb_usdc, eff_tokens, usdc_in)?;
        let price = if tokens_out > 0 {
            crate::math::mul_div(usdc_in, PRECISION, tokens_out)?
        } else { 0 };
        Ok((tokens_out, price))
    }

    pub fn get_sell_price(&self, tokens_in: u64) -> Result<u64> {
        let (_eff_base, eff_tokens, vb_usdc) = self.get_eff_and_vb_usdc()?;
        // usdcOut = vbUsdc × tokens_in / (effTokens + tokens_in)
        crate::math::calculate_usdc_out(vb_usdc, eff_tokens, tokens_in)
    }

    /// Update BC virtual reserves after a buy.
    /// nav = NAV captured BEFORE the buy (pre-state).
    /// max_bc_ratio_bps = factory-configured stored ratio cap (default 15_000 = 1.5×).
    pub fn update_bc_after_buy(&mut self, usdc_in: u64, tokens_out: u64, nav: u64, max_bc_ratio_bps: u64) -> Result<()> {
        let total_assets = self.get_total_assets();
        let (_, eff_tokens, vb_usdc) = {
            let (eff_base, eff_tokens) = crate::math::get_effective_virtuals(
                total_assets, self.bc_virtual_base, self.bc_virtual_tokens
            );
            let vb_usdc = ((eff_base as u128).saturating_mul(nav as u128) / PRECISION as u128) as u64;
            (eff_base, eff_tokens, vb_usdc)
        };
        let new_vb_usdc = vb_usdc.saturating_add(usdc_in);
        let new_eff_base = ((new_vb_usdc as u128).saturating_mul(PRECISION as u128)
            / nav.max(1) as u128) as u64;
        let new_eff_tokens = eff_tokens.saturating_sub(tokens_out).max(1);

        self.bc_virtual_base   = new_eff_base;
        self.bc_virtual_tokens = new_eff_tokens;

        // Stored ratio cap (factory-configurable): prevents price divergence
        let ratio_bps = ((self.bc_virtual_base as u128).saturating_mul(BPS as u128)
            / self.bc_virtual_tokens as u128) as u64;
        if ratio_bps > max_bc_ratio_bps {
            self.bc_virtual_tokens = crate::math::mul_div(
                self.bc_virtual_base, BPS, max_bc_ratio_bps
            )?;
        }
        Ok(())
    }

    /// Update BC virtual reserves after a sell.
    /// nav = NAV captured BEFORE the sell.
    /// exit_fee = exit fee deducted from gross (stays in vault as NAV increase).
    /// max_bc_ratio_bps = factory-configured stored ratio cap.
    pub fn update_bc_after_sell(&mut self, tokens_in: u64, gross_usdc: u64, exit_fee: u64, nav: u64, max_bc_ratio_bps: u64) -> Result<()> {
        let total_assets = self.get_total_assets();
        let (_, eff_tokens, vb_usdc) = {
            let (eff_base, eff_tokens) = crate::math::get_effective_virtuals(
                total_assets, self.bc_virtual_base, self.bc_virtual_tokens
            );
            let vb_usdc = ((eff_base as u128).saturating_mul(nav as u128) / PRECISION as u128) as u64;
            (eff_base, eff_tokens, vb_usdc)
        };
        // Exit fee stays in vault → only net outflow reduces BC base
        let after_exit_fee = gross_usdc.saturating_sub(exit_fee);
        let new_vb_usdc = vb_usdc.saturating_sub(after_exit_fee);
        let new_eff_base = ((new_vb_usdc as u128).saturating_mul(PRECISION as u128)
            / nav.max(1) as u128) as u64;
        let new_eff_tokens = eff_tokens.saturating_add(tokens_in);

        self.bc_virtual_base   = new_eff_base;
        self.bc_virtual_tokens = new_eff_tokens;

        // Ratio floor: price ≥ NAV (ratio ≥ 1.0)
        if self.bc_virtual_base < self.bc_virtual_tokens {
            self.bc_virtual_tokens = self.bc_virtual_base;
        }

        // Ratio cap: same as buy — prevents double-scaling drift after sell
        let ratio_bps = ((self.bc_virtual_base as u128).saturating_mul(BPS as u128)
            / self.bc_virtual_tokens.max(1) as u128) as u64;
        if ratio_bps > max_bc_ratio_bps {
            self.bc_virtual_tokens = crate::math::mul_div(
                self.bc_virtual_base, BPS, max_bc_ratio_bps
            )?;
        }
        Ok(())
    }
}

/// Per-user share record (PDA: [b"share", vault, user])
#[account]
pub struct VaultShare {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub amount: u64,        // Token amount (6 decimals)
    pub entry_nav: u64,     // NAV at acquisition time (PRECISION)
    pub acquired_at: i64,   // Unix timestamp
    pub bump: u8,
}

impl VaultShare {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1;

    pub fn get_exit_fee_bps(&self, current_time: i64) -> u64 {
        let hold_secs = (current_time - self.acquired_at).max(0) as u64;
        let hold_days = hold_secs / 86400;

        if hold_days >= 30 { 0 }
        else if hold_days >= 7 { 300 }
        else if hold_days >= 3 { 800 }
        else { 1500 }
    }
}
