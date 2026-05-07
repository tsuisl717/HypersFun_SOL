// Shared types for Bonding Curve Vault components (Solana version).
//
// Mirrors HyperVapor-Fun/components/bonding-curve-vault/types.ts but
// strips Hyperliquid L1 concepts (perp positions, builder DEX fills,
// funding history) — those have no Solana equivalent.
//
// Most string-typed fields kept as `string` (not `number`) so they can
// stay in raw on-chain units until the consumer formats them.

export interface VaultInfo {
  address: string;        // vault PDA (base58)
  leader: string;         // base58
  name: string;
  symbol: string;
  /** performance fee, basis points */
  feeBps: string;
  /** human-formatted vault token supply */
  totalSupply: string;
  /** TWAP NAV (smoothed) */
  nav: string;
  /** stabilised NAV (with virtual assets) */
  stabNav?: string;
  /** raw NAV = assets / supply */
  rawNav: string;
  /** spot buy price including trading fee */
  buyPrice: string;
  /** spot sell price including trading fee */
  sellPrice: string;
  metadataURI?: string;
  imageUrl?: string;
  description?: string;
  links?: { website?: string; telegram?: string; twitter?: string };
}

export interface BondingCurveInfo {
  /** raw u64 virtual base reserve */
  virtualBase: string;
  /** raw u64 virtual token reserve */
  virtualTokens: string;
  /** max premium over NAV, bps */
  maxPremiumBps: string;
  /** max discount under NAV, bps */
  maxDiscountBps: string;
  /** trading fee, bps */
  tradingFeeBps: string;
  /** human-formatted market cap */
  currentMarketCap: string;
}

export interface ReserveStatus {
  /** USDC held in vault PDA's USDC ATA */
  usdcReserve: string;
  /** assets parked outside the vault (e.g. Drift collateral) */
  externalAssets: string;
  /** sum (USDC + external) */
  totalAssets: string;
  /** reserve ratio in bps */
  currentRatioBps: string;
  /** flagged when ratio is below the factory minimum */
  isLow: boolean;
  /** lifetime volume, USDC */
  totalVolume: string;
  /** USDC immediately withdrawable */
  availableLiquidity: string;
  /** liquidity-capped sell price (when reserves are tight) */
  sellPriceCapped: string;
  isLiquidityCapped: boolean;
}

export interface ExitFeeTier {
  daysHeld: number;
  feeBps: number;
}

export interface ExitFeeConfig {
  enabled: boolean;
  recipient: string;
  tierCount: number;
}

export interface UserExitFeeInfo {
  totalTokens: string;
  /** weighted average buy timestamp (unix seconds) */
  weightedTimestamp: number;
  daysHeld: number;
  currentFeeBps: number;
}

export interface GraduationTier {
  /** total-assets threshold, USDC */
  threshold: number;
  /** virtual reserve depth at this tier */
  bcVirtual: number;
  /** display label */
  label: string;
  navMinMul: number;
  navMaxMul: number;
  /** squared-ratio weight in bps */
  squaredRatioBps?: number;
}

/**
 * Solana-side trade row (matches Anchor BuyEvent/SellEvent decoded by
 * `lib/vault-events.ts`).
 */
export interface VaultTradeRow {
  signature: string;
  side: 'buy' | 'sell';
  user: string;
  timestamp: number;
  usdc: number;
  tokens: number;
  price: number;
  navRaw: number;
  slot: number;
}

export interface HolderRow {
  owner: string;
  balance: number;
  percent: number;
}
