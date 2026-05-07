use crate::errors::HypersfunError;
use anchor_lang::prelude::*;

/// Calculate tokens_out from USDC input (bonding curve buy)
/// tokens_out = virtual_tokens * usdc_in / (virtual_base + usdc_in)
pub fn calculate_tokens_out(
    virtual_base: u64,
    virtual_tokens: u64,
    usdc_in: u64,
) -> Result<u64> {
    let num = (virtual_tokens as u128)
        .checked_mul(usdc_in as u128)
        .ok_or(HypersfunError::MathOverflow)?;

    let denom = (virtual_base as u128)
        .checked_add(usdc_in as u128)
        .ok_or(HypersfunError::MathOverflow)?;

    if denom == 0 {
        return err!(HypersfunError::DivisionByZero);
    }

    let tokens_out = num.checked_div(denom).ok_or(HypersfunError::MathOverflow)?;
    Ok(tokens_out as u64)
}

/// Calculate usdc_out from token input (bonding curve sell)
/// usdc_out = virtual_base * tokens_in / (virtual_tokens + tokens_in)
pub fn calculate_usdc_out(
    virtual_base: u64,
    virtual_tokens: u64,
    tokens_in: u64,
) -> Result<u64> {
    let num = (virtual_base as u128)
        .checked_mul(tokens_in as u128)
        .ok_or(HypersfunError::MathOverflow)?;

    let denom = (virtual_tokens as u128)
        .checked_add(tokens_in as u128)
        .ok_or(HypersfunError::MathOverflow)?;

    if denom == 0 {
        return err!(HypersfunError::DivisionByZero);
    }

    let usdc_out = num.checked_div(denom).ok_or(HypersfunError::MathOverflow)?;
    Ok(usdc_out as u64)
}

/// Calculate NAV = total_assets / total_supply (both in PRECISION)
pub fn calculate_nav(total_assets: u64, total_supply: u64) -> Result<u64> {
    if total_supply == 0 {
        return Ok(crate::types::PRECISION); // Default 1.0
    }

    let nav = (total_assets as u128)
        .checked_mul(crate::types::PRECISION as u128)
        .ok_or(HypersfunError::MathOverflow)?
        .checked_div(total_supply as u128)
        .ok_or(HypersfunError::DivisionByZero)?;

    Ok(nav as u64)
}

/// TWAP NAV smoothing (exponential moving average)
/// smoothed = instant - (instant - prev_twap) * decay
/// decay = 0.5^(elapsed / half_life)
pub fn calculate_twap_nav(
    instant_nav: u64,
    prev_twap: u64,
    prev_timestamp: i64,
    current_timestamp: i64,
    half_life: i64,
) -> u64 {
    if prev_twap == 0 || instant_nav >= prev_twap {
        return instant_nav;
    }

    let elapsed = (current_timestamp - prev_timestamp).max(0) as u64;
    let half_life = half_life.max(1) as u64;

    // If more than 10x half_life elapsed, use instant
    if elapsed >= half_life * 10 {
        return instant_nav;
    }

    // Approximate decay: decay_factor ≈ 1 - elapsed/(half_life * 1.443)
    // Use integer approximation: gap reduced by elapsed/half_life * 69% per period
    let gap = prev_twap.saturating_sub(instant_nav);
    let decay_numerator = elapsed.min(half_life * 10) * 1000 / half_life;
    let decay = decay_numerator.min(1000);
    let reduction = (gap as u128 * decay as u128 / 1000) as u64;

    instant_nav.saturating_add(gap.saturating_sub(reduction))
}

/// mul_div: a * b / c with overflow protection
pub fn mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    if c == 0 {
        return err!(HypersfunError::DivisionByZero);
    }
    let result = (a as u128)
        .checked_mul(b as u128)
        .ok_or(HypersfunError::MathOverflow)?
        .checked_div(c as u128)
        .ok_or(HypersfunError::MathOverflow)?;
    Ok(result as u64)
}

/// Get tier BC depth based on total_assets (EVM-aligned depths)
fn get_tier_bc(total_assets: u64) -> u64 {
    use crate::types::*;
    if total_assets >= TIER_GRADUATED_THRESHOLD { TIER_GRADUATED_BC }
    else if total_assets >= TIER_MATURE_THRESHOLD { TIER_MATURE_BC }
    else if total_assets >= TIER_GROWTH_THRESHOLD { TIER_GROWTH_BC }
    else if total_assets >= TIER_SEED_THRESHOLD { TIER_SEED_BC }
    else { DEFAULT_BC_VIRTUAL_BASE }
}

/// Get squaredRatioBps for current tier (EVM V38 progressive decay)
/// 10_000 = 100% squared (early, max amplification)
/// 0       = linear (tracks NAV closely)
pub fn get_squared_ratio_bps(total_assets: u64) -> u64 {
    use crate::types::*;
    if total_assets >= TIER_GRADUATED_THRESHOLD { TIER_GRADUATED_SQUARED_RATIO_BPS }
    else if total_assets >= TIER_MATURE_THRESHOLD { TIER_MATURE_SQUARED_RATIO_BPS }
    else if total_assets >= TIER_GROWTH_THRESHOLD { TIER_GROWTH_SQUARED_RATIO_BPS }
    else { DEFAULT_SQUARED_RATIO_BPS } // Seed and below = 90%
}

/// Get effective virtual reserves with EVM V38 progressive blend.
///
/// effBase   = tierBC × vBase / vTokens   (always ratio-scaled)
/// effTokens = squaredPart × sq% + linearPart × (1-sq%)
///   squaredPart = tierBC × vTokens / vBase  (full squared → price amplified)
///   linearPart  = tierBC                    (price = ratio × NAV)
///
/// Seed (90% sq):      price ≈ ratio^1.9 × NAV, max ~2× NAV at stored ratio 1.5
/// Graduated (2% sq):  price ≈ ratio × NAV  (tracks NAV closely)
pub fn get_effective_virtuals(total_assets: u64, virtual_base: u64, virtual_tokens: u64) -> (u64, u64) {
    use crate::types::BPS;
    let tier_bc = get_tier_bc(total_assets);
    if virtual_base == 0 || virtual_tokens == 0 {
        return (tier_bc, tier_bc);
    }

    let sq_bps = get_squared_ratio_bps(total_assets);

    // effBase: always ratio-scaled
    let eff_base = ((tier_bc as u128)
        .saturating_mul(virtual_base as u128)
        / virtual_tokens as u128) as u64;

    // effTokens: blend between squared and linear parts
    let squared_part = ((tier_bc as u128)
        .saturating_mul(virtual_tokens as u128)
        / virtual_base as u128) as u64;
    let linear_part = tier_bc;

    let eff_tokens: u64 = if sq_bps >= BPS {
        squared_part
    } else if sq_bps == 0 {
        linear_part
    } else {
        ((squared_part as u128 * sq_bps as u128
            + linear_part as u128 * (BPS - sq_bps) as u128)
            / BPS as u128) as u64
    };

    let eff_base   = eff_base.max(1);
    let eff_tokens = eff_tokens.max(1);

    // Defensive hard cap: effective ratio ≤ 5× (catches any corrupted stored state)
    let hard_cap_bps = 50_000u64;
    let ratio_bps = ((eff_base as u128).saturating_mul(BPS as u128) / eff_tokens as u128) as u64;
    if ratio_bps > hard_cap_bps {
        let capped = ((eff_base as u128).saturating_mul(BPS as u128)
            / hard_cap_bps as u128) as u64;
        return (eff_base, capped.max(1));
    }

    (eff_base, eff_tokens)
}

/// Read price from a Pyth V2 price account, converting to µUSDC (6 decimals).
///
/// Pyth V2 PriceAccount layout (relevant offsets):
///   0-3:   magic (u32) must be 0xa1b2c3d4
///   20-23: expo  (i32) — e.g. -8 for SOL/USD
///   204-211: agg.price  (i64)
///   220-223: agg.status (u32) — 1 = Trading
///
/// Conversion: price_µUSDC = price_raw × 10^(expo + 6)
pub fn read_pyth_price_usdc(data: &[u8]) -> Result<u64> {
    require!(data.len() >= 236, HypersfunError::InvalidOracle);

    // Validate Pyth magic
    let magic = u32::from_le_bytes(data[0..4].try_into().map_err(|_| error!(HypersfunError::InvalidOracle))?);
    require!(magic == 0xa1b2c3d4, HypersfunError::InvalidOracle);

    let expo = i32::from_le_bytes(data[20..24].try_into().map_err(|_| error!(HypersfunError::InvalidOracle))?);
    let price_raw = i64::from_le_bytes(data[204..212].try_into().map_err(|_| error!(HypersfunError::InvalidOracle))?);
    let status = u32::from_le_bytes(data[220..224].try_into().map_err(|_| error!(HypersfunError::InvalidOracle))?);

    require!(price_raw > 0, HypersfunError::InvalidOracle);
    require!(status == 1, HypersfunError::InvalidOracle); // 1 = Trading

    // Convert to µUSDC: target 6 decimal places
    let shift = expo + 6_i32;
    let price_usdc: u64 = if shift >= 0 {
        (price_raw as u128).saturating_mul(10u128.pow(shift as u32)) as u64
    } else {
        let divisor = 10u128.pow((-shift) as u32);
        ((price_raw as u128) / divisor) as u64
    };

    require!(price_usdc > 0, HypersfunError::InvalidOracle);
    Ok(price_usdc)
}

// ============================================================
// Unit Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;

    // Helpers for approximate equality (within 0.1%)
    fn approx_eq(a: u64, b: u64, tolerance_bps: u64) -> bool {
        let diff = if a > b { a - b } else { b - a };
        let threshold = b.saturating_mul(tolerance_bps) / 10_000;
        diff <= threshold.max(1)
    }

    // ============ Bonding Curve Tests ============

    #[test]
    fn test_buy_increases_price() {
        // Buy small amount: price should be close to virtual_base/virtual_tokens = 1.0
        let vb = DEFAULT_BC_VIRTUAL_BASE;   // 2_000_000_000_000
        let vt = DEFAULT_BC_VIRTUAL_TOKENS; // 2_000_000_000_000
        let usdc_in = 1_000_000; // 1 USDC

        let tokens = calculate_tokens_out(vb, vt, usdc_in).unwrap();
        // Expected: 2e12 * 1e6 / (2e12 + 1e6) ≈ 999_999 tokens (just under 1 USDC worth)
        assert!(tokens > 0, "tokens out must be > 0");
        assert!(tokens < usdc_in + 1, "tokens should be <= usdc_in for 1:1 start curve");
        println!("Buy 1 USDC → {} tokens ({}x)", tokens, tokens as f64 / usdc_in as f64);
    }

    #[test]
    fn test_sell_gives_back_less_than_buy_paid() {
        // Bonding curve: buy then sell same tokens → get back less USDC (spread)
        let vb = DEFAULT_BC_VIRTUAL_BASE;
        let vt = DEFAULT_BC_VIRTUAL_TOKENS;
        let usdc_in = 10_000_000; // 10 USDC

        let tokens = calculate_tokens_out(vb, vt, usdc_in).unwrap();
        let usdc_back = calculate_usdc_out(vb, vt, tokens).unwrap();

        assert!(usdc_back < usdc_in, "sell back should give less than buy cost (spread)");
        let spread_bps = (usdc_in - usdc_back) * 10_000 / usdc_in;
        println!("Buy/sell spread: {} bps ({:.4}%)", spread_bps, spread_bps as f64 / 100.0);
        // Spread should be very small for small trades on large virtual pool
        assert!(spread_bps < 10, "spread > 0.10% for small trade on large pool");
    }

    #[test]
    fn test_bonding_curve_price_impact() {
        // Larger buy → fewer tokens per USDC (higher effective price per token)
        // Use 1x (vb=vt) so initial price = 1.0, compare small vs very large trade
        let vb = DEFAULT_BC_VIRTUAL_BASE;
        let vt = DEFAULT_BC_VIRTUAL_TOKENS;

        // Small: 1 USDC → tokens ≈ 999_999 → ~1.0 USDC/token
        let small_usdc: u64 = 1_000_000;
        let small_tokens = calculate_tokens_out(vb, vt, small_usdc).unwrap();

        // Large: 200k USDC (= 10% of virtual pool) → noticeable price impact
        let large_usdc: u64 = 200_000_000_000; // 200k USDC
        let large_tokens = calculate_tokens_out(vb, vt, large_usdc).unwrap();

        // Price per token (USDC × 1e6 / tokens) — larger = higher price
        let small_price = small_usdc as u128 * 1_000_000 / small_tokens as u128;
        let large_price = large_usdc as u128 * 1_000_000 / large_tokens as u128;

        println!("Small buy (1 USDC): {} USDC/token | Large buy (200k USDC): {} USDC/token",
            small_price, large_price);
        assert!(large_price > small_price, "large buy should have higher price per token (price impact)");
    }

    #[test]
    fn test_bonding_curve_invariant() {
        // After buy then sell: total USDC returned < invested (curve is curved, not flat)
        let vb = DEFAULT_BC_VIRTUAL_BASE;
        let vt = DEFAULT_BC_VIRTUAL_TOKENS;
        let usdc_in: u64 = 50_000_000; // 50 USDC

        let tokens = calculate_tokens_out(vb, vt, usdc_in).unwrap();

        // Simulate new virtual params after buy
        let new_vb = vb + usdc_in;
        let new_vt = vt - tokens;

        let usdc_back = calculate_usdc_out(new_vb, new_vt, tokens).unwrap();
        println!("Bought {} tokens with {} USDC, got back {} USDC", tokens, usdc_in, usdc_back);
        // usdc_back should be very close to usdc_in (AMM preserves k = vb * vt)
        assert!(approx_eq(usdc_back, usdc_in, 5), "round-trip should return ~100% (within 0.05%)");
    }

    // ============ NAV Tests ============

    #[test]
    fn test_nav_zero_supply_returns_precision() {
        let nav = calculate_nav(0, 0).unwrap();
        assert_eq!(nav, PRECISION, "zero supply → NAV = 1.0");
    }

    #[test]
    fn test_nav_1_to_1() {
        // 1M USDC in vault, 1M tokens → NAV = 1.0
        let nav = calculate_nav(1_000_000_000_000, 1_000_000_000_000).unwrap();
        assert_eq!(nav, PRECISION, "equal assets and supply → NAV = 1.0 PRECISION");
    }

    #[test]
    fn test_nav_profit() {
        // 2M USDC, 1M tokens → NAV = 2.0
        let nav = calculate_nav(2_000_000, 1_000_000).unwrap();
        assert_eq!(nav, 2 * PRECISION, "double assets → NAV = 2.0");
    }

    // ============ TWAP Tests ============

    #[test]
    fn test_twap_no_change_if_instant_above_prev() {
        // If NAV went up, TWAP should just return instant (no smoothing needed)
        let twap = calculate_twap_nav(
            1_200_000, // instant = 1.2
            1_000_000, // prev_twap = 1.0
            0, 60, 600,
        );
        assert_eq!(twap, 1_200_000, "instant > prev → return instant");
    }

    #[test]
    fn test_twap_smooths_downward() {
        // NAV dropped: 1.0 → 0.5, after HALF a half-life (300s elapsed, half_life=600s)
        // gap = 500_000, decay_numerator = 300*1000/600 = 500 → 50% reduction
        // reduction = 500_000 * 500 / 1000 = 250_000
        // result = 500_000 + (500_000 - 250_000) = 750_000
        let twap = calculate_twap_nav(
            500_000,   // instant = 0.5
            1_000_000, // prev_twap = 1.0
            0, 300, 600, // elapsed = half_life/2
        );
        // Result should be between instant and prev_twap
        assert!(twap > 500_000, "TWAP should be above instant NAV (half decay elapsed)");
        assert!(twap < 1_000_000, "TWAP should be below prev_twap");
        assert_eq!(twap, 750_000, "after half decay: TWAP = 0.75");
        println!("TWAP after half half-life: {} (expected 750_000)", twap);
    }

    #[test]
    fn test_twap_long_elapsed_returns_instant() {
        // After 10x half-life, should fully converge to instant
        let twap = calculate_twap_nav(
            500_000,
            1_000_000,
            0, 6000, 600, // elapsed = 10 * half_life
        );
        assert_eq!(twap, 500_000, "after 10x half-life, TWAP = instant");
    }

    // ============ mul_div Tests ============

    #[test]
    fn test_mul_div_basic() {
        // 100 * 30 / 10000 = 0.3 (rounds down)
        let result = mul_div(100, 30, 10_000).unwrap();
        assert_eq!(result, 0); // 3000/10000 = 0.3, truncated to 0

        // 10000 * 30 / 10000 = 30
        let result = mul_div(10_000, 30, 10_000).unwrap();
        assert_eq!(result, 30);
    }

    #[test]
    fn test_mul_div_fee_calculation() {
        // 1% of 1_000_000 USDC
        let result = mul_div(1_000_000, 100, 10_000).unwrap();
        assert_eq!(result, 10_000); // 1% = 10,000

        // 0.3% trading fee on 50 USDC
        let result = mul_div(50_000_000, 30, 10_000).unwrap();
        assert_eq!(result, 150_000); // 0.3% of 50 = 0.15 USDC
    }

    #[test]
    fn test_mul_div_division_by_zero() {
        let result = mul_div(100, 100, 0);
        assert!(result.is_err(), "division by zero should error");
    }

    // ============ Graduation Tier Tests ============

    #[test]
    fn test_graduation_tiers() {
        let vb = DEFAULT_BC_VIRTUAL_BASE;
        let vt = DEFAULT_BC_VIRTUAL_TOKENS;

        // Under 10k USDC → 1x
        let (b, t) = get_effective_virtuals(5_000_000_000, vb, vt);
        assert_eq!(b, vb, "< 10k → 1x virtual_base");

        // 10k-100k USDC → 2x
        let (b, t) = get_effective_virtuals(TIER_1_THRESHOLD, vb, vt);
        assert_eq!(b, vb * 2, "10k+ → 2x virtual_base");

        // 100k-1M USDC → 4x
        let (b, t) = get_effective_virtuals(TIER_2_THRESHOLD, vb, vt);
        assert_eq!(b, vb * 4, "100k+ → 4x virtual_base");

        // > 1M USDC → 8x
        let (b, t) = get_effective_virtuals(TIER_3_THRESHOLD, vb, vt);
        assert_eq!(b, vb * 8, "1M+ → 8x virtual_base");
    }

    #[test]
    fn test_graduation_tiers_reduce_price_impact() {
        // Higher tier → bigger virtual pool → smaller price impact for same trade
        // Price impact = (new_price - initial_price) / initial_price
        // new_price = (vb + trade) / (vt - tokens_out)  [new virtual ratio]
        let vb = DEFAULT_BC_VIRTUAL_BASE;   // 2e12
        let vt = DEFAULT_BC_VIRTUAL_TOKENS; // 2e12
        let trade = 200_000_000_000u64;    // 200k USDC (10% of 1x pool)

        let (b1, t1) = get_effective_virtuals(0, vb, vt);               // 1x (2e12)
        let (b4, t4) = get_effective_virtuals(TIER_2_THRESHOLD, vb, vt); // 4x (8e12)

        let tokens_1x = calculate_tokens_out(b1, t1, trade).unwrap();
        let tokens_4x = calculate_tokens_out(b4, t4, trade).unwrap();

        // New price ratio after buy: (vb + trade) / (vt - tokens_out)
        // Scaled to avoid division issues: use cross multiply to compare
        // price_1x_num/denom vs price_4x_num/denom
        let price_1x_num = b1 + trade;
        let price_1x_den = t1 - tokens_1x;
        let price_4x_num = b4 + trade;
        let price_4x_den = t4 - tokens_4x;

        // price_1x > price_4x iff price_1x_num * price_4x_den > price_4x_num * price_1x_den
        let lhs = price_1x_num as u128 * price_4x_den as u128;
        let rhs = price_4x_num as u128 * price_1x_den as u128;

        println!("200k USDC buy: 1x tokens={}, 4x tokens={}", tokens_1x, tokens_4x);
        println!("Post-buy price 1x: {}/{} | 4x: {}/{}", price_1x_num, price_1x_den, price_4x_num, price_4x_den);
        assert!(lhs > rhs, "1x tier should have higher post-buy price (more price impact) than 4x tier");
    }

    // ============ Exit Fee Tests ============

    #[test]
    fn test_exit_fees_by_time() {
        // < 3 days → 15%
        let fee = get_exit_fee_bps(0, 1 * 86400);
        assert_eq!(fee, 1500, "< 3 days → 15%");

        // 3-7 days → 8%
        let fee = get_exit_fee_bps(0, 4 * 86400);
        assert_eq!(fee, 800, "4 days → 8%");

        // 7-30 days → 3%
        let fee = get_exit_fee_bps(0, 10 * 86400);
        assert_eq!(fee, 300, "10 days → 3%");

        // > 30 days → 0%
        let fee = get_exit_fee_bps(0, 31 * 86400);
        assert_eq!(fee, 0, "31 days → 0%");
    }

    fn get_exit_fee_bps(acquired_at: i64, current_time: i64) -> u64 {
        let hold_secs = (current_time - acquired_at).max(0) as u64;
        let hold_days = hold_secs / 86400;
        if hold_days >= 30 { 0 }
        else if hold_days >= 7 { 300 }
        else if hold_days >= 3 { 800 }
        else { 1500 }
    }
}
