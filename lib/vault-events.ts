'use client';

/**
 * vault-events — fetch real Buy/Sell events from the Solana RPC by parsing
 * Anchor program logs, with incremental localStorage caching so repeat
 * visits only sync new transactions.
 *
 * No subgraph required — works against any Solana RPC.
 */

import { Connection, PublicKey, ConfirmedSignatureInfo } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { EventParser } from '@coral-xyz/anchor';
import type { OHLCV } from '@/lib/indicators';

// ─── Types ──────────────────────────────────────────────────────────────────
export type TradeSide = 'buy' | 'sell';

export interface VaultTrade {
  signature: string;
  side: TradeSide;
  user: string;
  timestamp: number;       // unix seconds
  usdc: number;            // human USDC (gross — for buy: usdc_in, for sell: usdc_out)
  tokens: number;          // human vault tokens
  price: number;           // USDC per token
  nav: number;             // reported NAV at time of trade
  slot: number;
}

interface CacheShape {
  trades: VaultTrade[];      // sorted ascending by timestamp
  latestSig?: string;        // most recent signature seen (for incremental sync)
}

// ─── localStorage cache ─────────────────────────────────────────────────────
const CACHE_PREFIX = 'hypersfun:vault-trades:';
const MAX_CACHED_TRADES = 5000;

function cacheKey(vault: string): string {
  return CACHE_PREFIX + vault;
}

function readCache(vault: string): CacheShape {
  if (typeof window === 'undefined') return { trades: [] };
  try {
    const raw = localStorage.getItem(cacheKey(vault));
    if (!raw) return { trades: [] };
    const parsed = JSON.parse(raw) as CacheShape;
    return Array.isArray(parsed.trades) ? parsed : { trades: [] };
  } catch {
    return { trades: [] };
  }
}

function writeCache(vault: string, cache: CacheShape): void {
  if (typeof window === 'undefined') return;
  try {
    const trimmed: CacheShape = {
      ...cache,
      trades: cache.trades.length > MAX_CACHED_TRADES
        ? cache.trades.slice(-MAX_CACHED_TRADES)
        : cache.trades,
    };
    localStorage.setItem(cacheKey(vault), JSON.stringify(trimmed));
  } catch {
    // quota → drop oldest half and retry once
    try {
      const halved: CacheShape = {
        ...cache,
        trades: cache.trades.slice(-Math.floor(cache.trades.length / 2)),
      };
      localStorage.setItem(cacheKey(vault), JSON.stringify(halved));
    } catch { /* give up */ }
  }
}

export function clearVaultTradesCache(vault?: string): void {
  if (typeof window === 'undefined') return;
  if (vault) {
    localStorage.removeItem(cacheKey(vault));
    return;
  }
  // wipe all
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
  }
}

// ─── Concurrency helper ─────────────────────────────────────────────────────
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return out;
}

// ─── Event parsing ──────────────────────────────────────────────────────────
function parseEventsFromLogs(
  parser: EventParser,
  logs: string[],
): Array<{ name: string; data: Record<string, unknown> }> {
  const out: Array<{ name: string; data: Record<string, unknown> }> = [];
  try {
    for (const ev of parser.parseLogs(logs, false)) {
      out.push({ name: ev.name, data: ev.data as Record<string, unknown> });
    }
  } catch {
    // ignore — some logs may not decode cleanly
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bnToNumber(v: any): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v.toNumber === 'function') {
    try { return v.toNumber(); } catch { /* overflow */ }
    try { return Number(v.toString()); } catch { return 0; }
  }
  if (typeof v === 'string') return Number(v) || 0;
  return 0;
}

function eventToTrade(
  ev: { name: string; data: Record<string, unknown> },
  sig: string,
  slot: number,
): VaultTrade | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = ev.data as any;
  const timestamp = bnToNumber(d.timestamp);
  const nav = bnToNumber(d.nav) / 1e6;        // PRECISION = 1e6
  const user = d.user?.toBase58?.() ?? String(d.user ?? '');

  if (ev.name === 'BuyEvent') {
    const usdc = bnToNumber(d.usdcIn ?? d.usdc_in) / 1e6;
    const tokens = bnToNumber(d.tokensOut ?? d.tokens_out) / 1e6;
    if (usdc <= 0 || tokens <= 0) return null;
    return {
      signature: sig,
      side: 'buy',
      user,
      timestamp,
      usdc,
      tokens,
      price: usdc / tokens,
      nav,
      slot,
    };
  }
  if (ev.name === 'SellEvent') {
    const usdc = bnToNumber(d.usdcOut ?? d.usdc_out) / 1e6;
    const tokens = bnToNumber(d.tokensIn ?? d.tokens_in) / 1e6;
    if (usdc <= 0 || tokens <= 0) return null;
    return {
      signature: sig,
      side: 'sell',
      user,
      timestamp,
      usdc,
      tokens,
      price: usdc / tokens,
      nav,
      slot,
    };
  }
  return null;
}

// ─── Public: load trades (cached + incremental sync) ────────────────────────
export interface LoadTradesOptions {
  /** Max signatures to scan in one go. Default 500. */
  signatureLimit?: number;
  /** Concurrent transaction fetches. Default 5. */
  concurrency?: number;
  /** If true, ignore cache and rebuild from scratch. */
  forceRefresh?: boolean;
}

export async function loadVaultTrades(
  connection: Connection,
  program: anchor.Program,
  vault: PublicKey,
  options: LoadTradesOptions = {},
): Promise<VaultTrade[]> {
  const {
    signatureLimit = 500,
    concurrency = 5,
    forceRefresh = false,
  } = options;

  const vaultStr = vault.toBase58();
  const cache = forceRefresh ? { trades: [] } : readCache(vaultStr);

  // 1. List signatures touching this vault, only NEWER than what we've cached.
  const sigParams: { limit: number; until?: string } = { limit: signatureLimit };
  if (cache.latestSig) sigParams.until = cache.latestSig;

  let sigs: ConfirmedSignatureInfo[];
  try {
    sigs = await connection.getSignaturesForAddress(vault, sigParams);
  } catch (e) {
    console.warn('[vault-events] getSignaturesForAddress failed:', e);
    return cache.trades;
  }

  if (sigs.length === 0) {
    return cache.trades;
  }

  // 2. Set up the event parser
  const parser = new EventParser(program.programId, program.coder);

  // 3. Pull each transaction, parse logs, decode events into trades
  type FetchResult = VaultTrade[];
  const fetched = await mapWithConcurrency<ConfirmedSignatureInfo, FetchResult>(
    sigs,
    concurrency,
    async (s) => {
      try {
        const tx = await connection.getTransaction(s.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        const logs = tx?.meta?.logMessages ?? [];
        if (logs.length === 0) return [];
        const slot = tx?.slot ?? 0;
        const events = parseEventsFromLogs(parser, logs);
        const trades: VaultTrade[] = [];
        for (const ev of events) {
          const t = eventToTrade(ev, s.signature, slot);
          if (t) trades.push(t);
        }
        return trades;
      } catch {
        return [];
      }
    },
  );

  // 4. Flatten + sort by timestamp ascending
  const newTrades = fetched.flat().sort((a, b) => a.timestamp - b.timestamp);

  // 5. Merge with cache, dedupe by signature+side
  const merged = mergeTrades(cache.trades, newTrades);

  // 6. Newest signature for next incremental sync
  // Note: sigs[0] is the most recent (RPC returns desc by slot)
  const latestSig = sigs[0]?.signature ?? cache.latestSig;

  writeCache(vaultStr, { trades: merged, latestSig });
  return merged;
}

function mergeTrades(a: VaultTrade[], b: VaultTrade[]): VaultTrade[] {
  if (b.length === 0) return a;
  const seen = new Set<string>();
  const out: VaultTrade[] = [];
  for (const t of [...a, ...b]) {
    // dedupe key — multiple events can share a signature, so include side
    const key = `${t.signature}:${t.side}:${t.timestamp}:${t.user}:${t.usdc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((x, y) => x.timestamp - y.timestamp);
}

// ─── Public: bucket trades into OHLCV candles ───────────────────────────────
export function buildCandlesFromTrades(
  trades: VaultTrade[],
  intervalSecs: number,
): OHLCV[] {
  if (trades.length === 0) return [];

  const buckets = new Map<number, { trades: VaultTrade[] }>();
  for (const t of trades) {
    if (!t.timestamp || !t.price || !isFinite(t.price)) continue;
    const bucket = Math.floor(t.timestamp / intervalSecs) * intervalSecs;
    const cur = buckets.get(bucket);
    if (cur) cur.trades.push(t);
    else buckets.set(bucket, { trades: [t] });
  }

  const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);

  const candles: OHLCV[] = [];
  let prevClose = 0;

  for (const [bucket, { trades: ts }] of sortedBuckets) {
    // Trades are inserted in scan order which is ascending after merge.
    const open = ts[0].price;
    const close = ts[ts.length - 1].price;
    let high = open, low = open;
    let volume = 0;
    for (const t of ts) {
      if (t.price > high) high = t.price;
      if (t.price < low)  low  = t.price;
      volume += t.usdc;
    }
    candles.push({ time: bucket, open, high, low, close, volume });
    prevClose = close;
  }

  // Forward-fill empty buckets between the first and last bucket so the chart
  // doesn't have holes when there's no trading activity for a while.
  if (candles.length > 1) {
    const filled: OHLCV[] = [];
    for (let i = 0; i < candles.length - 1; i++) {
      filled.push(candles[i]);
      const cur = candles[i];
      const nxt = candles[i + 1];
      const gap = (nxt.time - cur.time) / intervalSecs;
      if (gap > 1 && gap < 1000) {
        for (let g = 1; g < gap; g++) {
          const t = cur.time + g * intervalSecs;
          filled.push({
            time: t,
            open: cur.close,
            high: cur.close,
            low: cur.close,
            close: cur.close,
            volume: 0,
          });
        }
      }
    }
    filled.push(candles[candles.length - 1]);
    return filled;
  }

  // suppress unused warning for prevClose tracker (kept for potential future use)
  void prevClose;
  return candles;
}
