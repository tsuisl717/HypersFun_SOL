/**
 * vault-events — fetch real Buy/Sell events from the Solana RPC by parsing
 * Anchor program logs.
 *
 * This module is isomorphic (works on both Node server and browser).
 * Caching is the caller's responsibility:
 *   - Server-side: app/api/vault/candles/route.ts keeps an in-memory Map
 *     keyed by vault address with a 2-minute TTL (mirrors HyperVapor's
 *     subgraph candlesCache).
 *   - Client-side: optional, currently unused — the API route's response
 *     headers carry HTTP cache control instead.
 *
 * Uses connection.getTransactions (batched JSON-RPC) so one HTTP call
 * carries N method invocations — friendlier on rate-limited public RPCs.
 */

import { Connection, PublicKey, ConfirmedSignatureInfo } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import type { OHLCV } from '@/lib/indicators';

const DEBUG = process.env.NODE_ENV !== 'production';
const dlog = (...args: unknown[]) => { if (DEBUG) console.log('[vault-events]', ...args); };

// ─── Types ──────────────────────────────────────────────────────────────────
export type TradeSide = 'buy' | 'sell';

export interface VaultTrade {
  signature: string;
  side: TradeSide;
  user: string;
  timestamp: number;       // unix seconds
  usdc: number;            // human USDC (gross — buy: usdc_in, sell: usdc_out)
  tokens: number;          // human vault tokens
  price: number;           // chart price = NAV at trade time (USDC per token)
  navRaw: number;          // same as price; kept for clarity
  exitFee: number;         // human USDC — sell-only (0 for buy)
  perfFee: number;         // human USDC — sell-only (0 for buy)
  slot: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
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

  // Anchor 0.30+ may normalize event names to camelCase ("buyEvent") while
  // older IDL spec keeps the Rust PascalCase ("BuyEvent"). Compare case-
  // insensitively so we accept both forms.
  const name = ev.name.toLowerCase();

  if (name === 'buyevent') {
    const usdc = bnToNumber(d.usdcIn ?? d.usdc_in) / 1e6;
    const tokens = bnToNumber(d.tokensOut ?? d.tokens_out) / 1e6;
    if (usdc <= 0 || tokens <= 0 || nav <= 0) return null;
    return { signature: sig, side: 'buy', user, timestamp, usdc, tokens, price: nav, navRaw: nav, exitFee: 0, perfFee: 0, slot };
  }
  if (name === 'sellevent') {
    const usdc = bnToNumber(d.usdcOut ?? d.usdc_out) / 1e6;
    const tokens = bnToNumber(d.tokensIn ?? d.tokens_in) / 1e6;
    const exitFee = bnToNumber(d.exitFee ?? d.exit_fee) / 1e6;
    const perfFee = bnToNumber(d.perfFee ?? d.perf_fee) / 1e6;
    if (usdc <= 0 || tokens <= 0 || nav <= 0) return null;
    return { signature: sig, side: 'sell', user, timestamp, usdc, tokens, price: nav, navRaw: nav, exitFee, perfFee, slot };
  }
  return null;
}

// ─── Public: fetch new trades since a given signature ───────────────────────
export interface FetchTradesOptions {
  /** Max signatures to scan in one go. Default 300. */
  signatureLimit?: number;
  /** Cursor — only fetch signatures newer than this one. */
  since?: string;
}

export interface FetchTradesResult {
  trades: VaultTrade[];
  /** Newest signature observed in this fetch (use as `since` next time). */
  latestSig: string | null;
}

/**
 * Returns trades NEWER than `options.since`. Caller is responsible for
 * merging with any existing cache.
 */
export async function fetchVaultTrades(
  connection: Connection,
  program: anchor.Program,
  vault: PublicKey,
  options: FetchTradesOptions = {},
): Promise<FetchTradesResult> {
  const { signatureLimit = 300, since } = options;
  const vaultStr = vault.toBase58();

  // 1. List signatures touching this vault, only NEWER than the cursor.
  const sigParams: { limit: number; until?: string } = { limit: signatureLimit };
  if (since) sigParams.until = since;

  let sigs: ConfirmedSignatureInfo[];
  try {
    sigs = await connection.getSignaturesForAddress(vault, sigParams);
    dlog(
      `getSignaturesForAddress(${vaultStr.slice(0, 8)}…) -> ${sigs.length} sigs`,
      since ? `(since ${since.slice(0, 8)}…)` : '(initial scan)',
    );
  } catch (e) {
    // If `until` is set but pruned, retry without it.
    if (sigParams.until) {
      try {
        sigs = await connection.getSignaturesForAddress(vault, { limit: signatureLimit });
        dlog(`retry without until -> ${sigs.length} sigs`);
      } catch (e2) {
        console.warn('[vault-events] getSignaturesForAddress failed:', e2);
        return { trades: [], latestSig: null };
      }
    } else {
      console.warn('[vault-events] getSignaturesForAddress failed:', e);
      return { trades: [], latestSig: null };
    }
  }

  if (sigs.length === 0) {
    return { trades: [], latestSig: null };
  }

  // 2. Batch-fetch transactions. `getTransactions` sends a single JSON-RPC
  //    batch instead of N parallel HTTP calls — much friendlier on devnet's
  //    public rate limit. We still chunk to keep batch size reasonable.
  const parser = new anchor.EventParser(program.programId, program.coder);
  const sigStrings = sigs.map((s) => s.signature);

  const BATCH_SIZE = 25;
  const trades: VaultTrade[] = [];
  let txOk = 0, txMissing = 0, txWithEvents = 0, totalEvents = 0;

  for (let i = 0; i < sigStrings.length; i += BATCH_SIZE) {
    const chunk = sigStrings.slice(i, i + BATCH_SIZE);
    let txs: Awaited<ReturnType<Connection['getTransactions']>> = [];
    try {
      txs = await connection.getTransactions(chunk, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch (e) {
      console.warn('[vault-events] getTransactions chunk failed, skipping', e);
      continue;
    }

    for (let j = 0; j < txs.length; j++) {
      const tx = txs[j];
      const sig = chunk[j];
      if (!tx) { txMissing++; continue; }
      txOk++;
      const logs = tx.meta?.logMessages ?? [];
      if (logs.length === 0) continue;
      const slot = tx.slot ?? 0;

      let foundOne = false;
      for (const ev of parser.parseLogs(logs, false)) {
        const lower = ev.name.toLowerCase();
        if (lower !== 'buyevent' && lower !== 'sellevent') {
          dlog(`skip non-trade event: ${ev.name}`);
          continue;
        }
        const trade = eventToTrade(
          { name: ev.name, data: ev.data as Record<string, unknown> },
          sig,
          slot,
        );
        if (trade) {
          trades.push(trade);
          totalEvents++;
          foundOne = true;
        } else {
          dlog(`event ${ev.name} failed to decode for sig ${sig.slice(0, 8)}…`);
        }
      }
      if (foundOne) txWithEvents++;
    }

    if (i + BATCH_SIZE < sigStrings.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  dlog(
    `fetched ${txOk}/${sigs.length} txs · ${txWithEvents} had events · ${totalEvents} events`,
    txMissing > 0 ? `(${txMissing} missing — RPC pruned?)` : '',
  );

  trades.sort((a, b) => a.timestamp - b.timestamp);
  return { trades, latestSig: sigs[0]?.signature ?? null };
}

// ─── Public: merge two trade lists (dedupe) ─────────────────────────────────
export function mergeTrades(a: VaultTrade[], b: VaultTrade[]): VaultTrade[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b.slice().sort((x, y) => x.timestamp - y.timestamp);
  const seen = new Set<string>();
  const out: VaultTrade[] = [];
  for (const t of [...a, ...b]) {
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
  for (const [bucket, { trades: ts }] of sortedBuckets) {
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
  }

  // Forward-fill empty buckets between first and last.
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
            open: cur.close, high: cur.close, low: cur.close, close: cur.close,
            volume: 0,
          });
        }
      }
    }
    filled.push(candles[candles.length - 1]);
    return filled;
  }

  return candles;
}

// ─── Interval helpers ───────────────────────────────────────────────────────
export const SUPPORTED_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Interval = (typeof SUPPORTED_INTERVALS)[number];

export function intervalToSeconds(interval: Interval): number {
  switch (interval) {
    case '1m':  return 60;
    case '5m':  return 300;
    case '15m': return 900;
    case '1h':  return 3600;
    case '4h':  return 14400;
    case '1d':  return 86400;
  }
}
