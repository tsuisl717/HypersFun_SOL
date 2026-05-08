/**
 * Drift Protocol Data API client.
 *
 * - Markets:  GET /marketsAndOraclesForUI       (mainnet only — devnet has no UI API)
 * - Candles:  GET /market/{symbol}/candles/{resolution}?startTs=&endTs=
 *
 * Fallback strategy:
 *   - Always attempt the API first (works for whichever network it serves).
 *   - On failure, return a hardcoded list (markets) or empty array (candles).
 *
 * Drift devnet (vELoC1 fork) does NOT publish a public Data API. We can still
 * surface a curated market list and show a "no chart history" placeholder.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { NETWORK, DRIFT_CONFIG } from '@/lib/contracts/config';
import type { OHLCV } from '@/lib/indicators';

const DRIFT_API_BASE = 'https://data.api.drift.trade';

export interface DriftMarket {
  marketIndex: number;
  symbol: string;       // e.g. "SOL-PERP"
  baseSymbol: string;   // e.g. "SOL"
  oracle?: string;
  isTradeable: boolean; // true only if our vault program supports it
}

export type DriftResolution = '1' | '5' | '15' | '60' | '240' | 'D' | 'W';

// ─── Hardcoded fallback markets ─────────────────────────────────────────────
// Subset of Drift mainnet perp markets with stable indices.
// Source: drift-labs/protocol-v2 mainnet config.
const KNOWN_MARKETS: Omit<DriftMarket, 'isTradeable'>[] = [
  { marketIndex: 0,  symbol: 'SOL-PERP',   baseSymbol: 'SOL'   },
  { marketIndex: 1,  symbol: 'BTC-PERP',   baseSymbol: 'BTC'   },
  { marketIndex: 2,  symbol: 'ETH-PERP',   baseSymbol: 'ETH'   },
  { marketIndex: 3,  symbol: 'APT-PERP',   baseSymbol: 'APT'   },
  { marketIndex: 4,  symbol: '1MBONK-PERP', baseSymbol: 'BONK' },
  { marketIndex: 5,  symbol: 'MATIC-PERP', baseSymbol: 'MATIC' },
  { marketIndex: 6,  symbol: 'ARB-PERP',   baseSymbol: 'ARB'   },
  { marketIndex: 7,  symbol: 'DOGE-PERP',  baseSymbol: 'DOGE'  },
  { marketIndex: 8,  symbol: 'BNB-PERP',   baseSymbol: 'BNB'   },
  { marketIndex: 9,  symbol: 'SUI-PERP',   baseSymbol: 'SUI'   },
  { marketIndex: 10, symbol: '1MPEPE-PERP', baseSymbol: 'PEPE' },
  { marketIndex: 11, symbol: 'OP-PERP',    baseSymbol: 'OP'    },
  { marketIndex: 12, symbol: 'RNDR-PERP',  baseSymbol: 'RNDR'  },
  { marketIndex: 13, symbol: 'XRP-PERP',   baseSymbol: 'XRP'   },
  { marketIndex: 14, symbol: 'HNT-PERP',   baseSymbol: 'HNT'   },
  { marketIndex: 15, symbol: 'INJ-PERP',   baseSymbol: 'INJ'   },
  { marketIndex: 16, symbol: 'LINK-PERP',  baseSymbol: 'LINK'  },
  { marketIndex: 17, symbol: 'RLB-PERP',   baseSymbol: 'RLB'   },
  { marketIndex: 18, symbol: 'PYTH-PERP',  baseSymbol: 'PYTH'  },
  { marketIndex: 19, symbol: 'TIA-PERP',   baseSymbol: 'TIA'   },
  { marketIndex: 20, symbol: 'JTO-PERP',   baseSymbol: 'JTO'   },
  { marketIndex: 21, symbol: 'SEI-PERP',   baseSymbol: 'SEI'   },
  { marketIndex: 22, symbol: 'AVAX-PERP',  baseSymbol: 'AVAX'  },
  { marketIndex: 23, symbol: 'WIF-PERP',   baseSymbol: 'WIF'   },
  { marketIndex: 24, symbol: 'JUP-PERP',   baseSymbol: 'JUP'   },
  { marketIndex: 25, symbol: 'DYM-PERP',   baseSymbol: 'DYM'   },
  { marketIndex: 26, symbol: 'TAO-PERP',   baseSymbol: 'TAO'   },
  { marketIndex: 27, symbol: 'W-PERP',     baseSymbol: 'W'     },
  { marketIndex: 28, symbol: 'KMNO-PERP',  baseSymbol: 'KMNO'  },
  { marketIndex: 29, symbol: 'TNSR-PERP',  baseSymbol: 'TNSR'  },
];

/** Resolve a Drift perp market index to its canonical symbol (e.g. 0 → "SOL-PERP"). */
export function getMarketSymbol(marketIndex: number): string {
  return KNOWN_MARKETS.find((m) => m.marketIndex === marketIndex)?.symbol ?? `MKT-${marketIndex}`;
}

/**
 * `isTradeable` is set to `true` for every market in the curated list — the
 * vault program forwards `market_index` + caller-provided `perp_market` /
 * `perp_oracle` to Drift CPI, so any market that exists on-chain is fair game.
 *
 * The actual gate now happens at runtime: `MarginTradingPanel` resolves the
 * PerpMarket PDA + oracle for the selected market and only enables trading
 * once that lookup succeeds. Markets that aren't deployed on the current
 * cluster surface as a yellow "PerpMarket account not found" warning.
 */

// ─── Public: fetch markets ──────────────────────────────────────────────────
export async function fetchDriftMarkets(): Promise<DriftMarket[]> {
  // mainnet → try Data API first
  if (NETWORK === 'mainnet-beta') {
    try {
      const res = await fetch(`${DRIFT_API_BASE}/marketsAndOraclesForUI`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        const parsed = parsePerpMarkets(data);
        if (parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.warn('[drift] markets API failed, falling back to hardcoded list:', e);
    }
  }

  // devnet OR API failed → curated list (all assumed tradeable; on-chain
  // existence is checked lazily when the user selects a market)
  return KNOWN_MARKETS.map((m) => ({ ...m, isTradeable: true }));
}

// ─── Public: fetch candles ──────────────────────────────────────────────────
export type CandlesSource = 'drift' | 'binance' | 'none';

export interface CandlesResult {
  candles: OHLCV[];
  source: CandlesSource;
}

/**
 * Fetch candles for a Drift perp.
 *
 * Strategy:
 *   • Mainnet: try Drift Data API first → fall back to Binance Futures
 *     (drift fills closely track CEX since the AMM is oracle-anchored).
 *   • Devnet (vELoC1 fork): no Data API exists — go straight to Binance
 *     so users still see real chart history while testing.
 *
 * Symbol mapping is defined in `driftSymbolToBinance`. Markets without a
 * Binance equivalent return `{ candles: [], source: 'none' }`.
 */
export async function fetchDriftCandles(
  symbol: string,
  resolution: DriftResolution = '60',
  limit = 200,
): Promise<CandlesResult> {
  // Mainnet: try the official API first.
  if (NETWORK === 'mainnet-beta') {
    const driftCandles = await fetchDriftApiCandles(symbol, resolution, limit);
    if (driftCandles.length > 0) {
      return { candles: driftCandles, source: 'drift' };
    }
  }

  // Devnet, or Drift API empty/failed → Binance.
  const binanceCandles = await fetchBinanceCandles(symbol, resolution, limit);
  if (binanceCandles.length > 0) {
    return { candles: binanceCandles, source: 'binance' };
  }

  return { candles: [], source: 'none' };
}

async function fetchDriftApiCandles(
  symbol: string,
  resolution: DriftResolution,
  limit: number,
): Promise<OHLCV[]> {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - limit * resolutionToSeconds(resolution);
  try {
    const res = await fetch(
      `${DRIFT_API_BASE}/market/${symbol}/candles/${resolution}` +
        `?startTs=${startTs}&endTs=${endTs}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return parseCandles(await res.json());
  } catch (e) {
    console.warn(`[drift] candles fetch failed for ${symbol}:`, e);
    return [];
  }
}

// ─── Binance fallback ───────────────────────────────────────────────────────
const BINANCE_FAPI_BASE = 'https://fapi.binance.com';
const BINANCE_SAPI_BASE = 'https://api.binance.com';

/**
 * Map a Drift perp symbol to the equivalent Binance USDT pair.
 * Drift's `1MBASE-PERP` markets bundle 1,000,000 units; Binance typically
 * exposes the same idea as `1000BASE-USDT` (1,000 units), so prices differ
 * by 1000×. We keep the price as-is — chart shape is what matters; the
 * absolute level is calibrated against the on-chain oracle anyway.
 */
export function driftSymbolToBinance(symbol: string): string | null {
  const base = symbol.replace(/-PERP$/i, '').toUpperCase();
  if (!base) return null;

  // Markets with a 1M (= one million) prefix → Binance's 1000-prefix pair.
  if (base.startsWith('1M')) {
    const inner = base.slice(2);
    if (!inner) return null;
    return `1000${inner}USDT`;
  }
  return `${base}USDT`;
}

const BINANCE_INTERVAL: Record<DriftResolution, string> = {
  '1':   '1m',
  '5':   '5m',
  '15':  '15m',
  '60':  '1h',
  '240': '4h',
  'D':   '1d',
  'W':   '1w',
};

export async function fetchBinanceCandles(
  driftSymbol: string,
  resolution: DriftResolution,
  limit: number,
): Promise<OHLCV[]> {
  const binanceSymbol = driftSymbolToBinance(driftSymbol);
  if (!binanceSymbol) return [];
  const interval = BINANCE_INTERVAL[resolution];
  const cappedLimit = Math.min(Math.max(limit, 1), 1500);

  // Try Binance Futures (USDT-M perpetuals) first, then Spot as fallback —
  // some perps (e.g. WIF) didn't ship on Spot until later.
  for (const base of [BINANCE_FAPI_BASE, BINANCE_SAPI_BASE]) {
    const path = base === BINANCE_FAPI_BASE ? '/fapi/v1/klines' : '/api/v3/klines';
    try {
      const res = await fetch(
        `${base}${path}?symbol=${binanceSymbol}&interval=${interval}&limit=${cappedLimit}`,
        { cache: 'no-store' },
      );
      if (!res.ok) continue;
      const raw = await res.json();
      const parsed = parseBinanceKlines(raw);
      if (parsed.length > 0) return parsed;
    } catch (e) {
      console.warn(`[binance] klines fetch failed for ${binanceSymbol}:`, e);
    }
  }
  return [];
}

function parseBinanceKlines(raw: unknown): OHLCV[] {
  if (!Array.isArray(raw)) return [];
  const out: OHLCV[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    // [openTime(ms), open, high, low, close, volume, closeTime, ...]
    const time = Math.floor(Number(row[0]) / 1000);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    if (!Number.isFinite(time) || !Number.isFinite(open)) continue;
    out.push({ time, open, high, low, close, volume });
  }
  return out.sort((a, b) => a.time - b.time);
}

// ─── On-chain PerpMarket lookup ─────────────────────────────────────────────
// Drift PerpMarket layout (offsets from start of account data):
//   0..8    : Anchor account discriminator
//   8..40   : pubkey (Pubkey)
//   40..72  : amm.oracle (Pubkey)  ← AMM is at offset 32, oracle is its first field
//
// PDA seed: [b"perp_market", market_index_le_u16] under Drift program.
//
// vELoC1 devnet uses the same layout — it's a Drift fork.

export interface PerpMarketInfo {
  marketIndex: number;
  perpMarketPda: string;
  oracle: string;
}

export function getPerpMarketPda(marketIndex: number): PublicKey {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(marketIndex, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('perp_market'), buf],
    new PublicKey(DRIFT_CONFIG.programId),
  );
  return pda;
}

export async function fetchPerpMarketInfo(
  connection: Connection,
  marketIndex: number,
): Promise<PerpMarketInfo | null> {
  const pda = getPerpMarketPda(marketIndex);
  const acc = await connection.getAccountInfo(pda);
  if (!acc || acc.data.length < 72) return null;
  const oraclePubkey = new PublicKey(acc.data.subarray(40, 72));
  return {
    marketIndex,
    perpMarketPda: pda.toBase58(),
    oracle: oraclePubkey.toBase58(),
  };
}

export function resolutionToSeconds(r: DriftResolution): number {
  switch (r) {
    case '1':   return 60;
    case '5':   return 300;
    case '15':  return 900;
    case '60':  return 3600;
    case '240': return 14400;
    case 'D':   return 86400;
    case 'W':   return 604800;
  }
}

// ─── Internal: response parsers ─────────────────────────────────────────────
// Drift's response shapes are not strictly versioned — we tolerate variants.

function parsePerpMarkets(raw: unknown): DriftMarket[] {
  const obj = raw as { perpMarkets?: unknown[]; data?: { perpMarkets?: unknown[] } };
  const list = obj?.perpMarkets ?? obj?.data?.perpMarkets ?? [];
  if (!Array.isArray(list)) return [];

  const out: DriftMarket[] = [];
  for (const m of list) {
    const item = m as Record<string, unknown>;
    const idx = numberOrUndef(item.marketIndex ?? item.market_index);
    const name = stringOrUndef(item.name ?? item.symbol);
    if (idx == null || !name) continue;

    const baseSymbol = name.replace(/-PERP$/i, '').replace(/^1M/, '');
    const oracle =
      stringOrUndef(item.oracle) ??
      stringOrUndef((item.amm as Record<string, unknown> | undefined)?.oracle);

    out.push({
      marketIndex: idx,
      symbol: name,
      baseSymbol,
      oracle,
      isTradeable: true,
    });
  }
  return out.sort((a, b) => a.marketIndex - b.marketIndex);
}

function parseCandles(raw: unknown): OHLCV[] {
  const obj = raw as { records?: unknown[]; candles?: unknown[]; data?: unknown[] };
  const list = obj?.records ?? obj?.candles ?? obj?.data ?? [];
  if (!Array.isArray(list)) return [];

  const out: OHLCV[] = [];
  for (const c of list) {
    const item = c as Record<string, unknown>;
    const time = numberOrUndef(item.ts ?? item.time ?? item.timestamp);
    const open = numberOrUndef(item.fillOpen ?? item.open);
    const high = numberOrUndef(item.fillHigh ?? item.high);
    const low = numberOrUndef(item.fillLow ?? item.low);
    const close = numberOrUndef(item.fillClose ?? item.close);
    const volume = numberOrUndef(
      item.fillBaseAssetAmount ?? item.volume ?? item.baseVolume,
    );
    if (time == null || open == null || high == null || low == null || close == null) continue;
    out.push({ time, open, high, low, close, volume: volume ?? 0 });
  }
  return out.sort((a, b) => a.time - b.time);
}

function numberOrUndef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
