'use client';

/**
 * vault-data-cache — client-side SWR cache for /api/vault/report and
 * /api/vault/candles, shared across all components in the vault page.
 *
 * Why this exists:
 *   - Both ActivityTabs (history/holders) and SimulationPanel (trading
 *     report) hit /api/vault/report. When the user switches tabs, those
 *     components unmount and remount, losing their local useState — which
 *     means the spinner flashes and the JSON payload re-downloads even
 *     though the server-side cache returns it in milliseconds.
 *   - AdvancedChart hits /api/vault/candles, which shares the same
 *     server-side trade cache. Same UX problem.
 *   - After a buy/sell, the server cache is still hot (2-min TTL) and
 *     would return stale data unless we forward `?force=1`. This module
 *     centralises that invalidate-and-refetch flow.
 *
 * Behaviour (SWR-style):
 *   - Cache hit & fresh (<60s)  → return cached, no fetch
 *   - Cache hit & stale         → return cached + background refresh
 *   - Cache miss                → fetch
 *   - invalidateVault(vault)    → clear report + candles for that vault,
 *                                 trigger force-refresh (so server skips
 *                                 its TTL gate too) and notify subscribers
 */

import { useEffect, useState } from 'react';

// ─── Types (mirror API responses) ───────────────────────────────────────────
export interface ReportTrade {
  signature: string;
  side: 'buy' | 'sell';
  user: string;
  timestamp: number;
  usdc: number;
  tokens: number;
  price: number;
  navRaw: number;
  exitFee: number;
  perfFee: number;
  slot: number;
}

export interface ReportHolder {
  owner: string;
  balance: number;
  percent: number;
}

export interface ReportMarginTrade {
  signature: string;
  side: 'open' | 'close';
  leader: string;
  marketIndex: number;
  direction: 'long' | 'short';
  baseAmount: number;
  usdcCollateral: number;
  usdcReturned: number;
  pnl: number;
  timestamp: number;
  slot: number;
}

export interface ReportOpenPosition {
  pda: string;
  marketIndex: number;
  direction: 'long' | 'short';
  baseAmount: number;
  usdcCollateral: number;
  entryPrice: number;
  openedAt: number;
}

export interface ReportData {
  vault: string;
  lastSync: number;
  meta: { symbol: string; name: string; tokenMint: string; decimals: number } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summary: any;
  topHolders: ReportHolder[];
  recentTrades: ReportTrade[];
  marginTrades: ReportMarginTrade[];
  openPositions: ReportOpenPosition[];
  navHistory: { time: number; value: number }[];
}

export interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandlesData {
  vault: string;
  interval: string;
  tradeCount: number;
  candles: OHLCV[];
  lastSync: number;
}

// ─── Cache infrastructure ───────────────────────────────────────────────────
const FRESH_TTL_MS = 60 * 1000; // 60s — match server's max-age

interface CacheEntry<T> {
  data: T | null;
  fetchedAt: number;       // 0 = never
  error: string | null;
  inflight: Promise<T> | null;
  subscribers: Set<() => void>;
}

function makeEntry<T>(): CacheEntry<T> {
  return { data: null, fetchedAt: 0, error: null, inflight: null, subscribers: new Set() };
}

const reportCache = new Map<string, CacheEntry<ReportData>>();
const candlesCache = new Map<string, CacheEntry<CandlesData>>();

function notify<T>(entry: CacheEntry<T>) {
  for (const cb of entry.subscribers) cb();
}

// ─── Fetchers ───────────────────────────────────────────────────────────────
async function fetchReport(vault: string, force: boolean): Promise<ReportData> {
  const qs = force ? '&force=1' : '';
  const res = await fetch(`/api/vault/report?vault=${vault}${qs}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as ReportData;
}

async function fetchCandles(
  vault: string,
  interval: string,
  limit: number,
  force: boolean,
): Promise<CandlesData> {
  const qs = force ? '&force=1' : '';
  const res = await fetch(
    `/api/vault/candles?vault=${vault}&interval=${interval}&limit=${limit}${qs}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as CandlesData;
}

// ─── Generic SWR helper ─────────────────────────────────────────────────────
function getOrCreate<T>(map: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> {
  let entry = map.get(key);
  if (!entry) {
    entry = makeEntry<T>();
    map.set(key, entry);
  }
  return entry;
}

function startFetch<T>(
  entry: CacheEntry<T>,
  fetcher: () => Promise<T>,
): Promise<T> {
  if (entry.inflight) return entry.inflight;
  const p = (async () => {
    try {
      const data = await fetcher();
      entry.data = data;
      entry.fetchedAt = Date.now();
      entry.error = null;
      return data;
    } catch (e) {
      entry.error = e instanceof Error ? e.message : 'load failed';
      throw e;
    } finally {
      entry.inflight = null;
      notify(entry);
    }
  })();
  entry.inflight = p;
  return p;
}

// ─── Public: invalidation ───────────────────────────────────────────────────
/**
 * Clear report + all candles cache for `vault` and trigger force-refresh
 * fetches. Subscribers are notified once new data lands.
 *
 * Call this after a successful buy/sell so history, chart and holders
 * pick up the new trade without waiting for the server TTL.
 */
export function invalidateVault(vault: string): void {
  // Report
  const r = reportCache.get(vault);
  if (r) {
    r.fetchedAt = 0;
    r.error = null;
    // Kick off force refresh; ignore errors (subscribers see entry.error).
    startFetch(r, () => fetchReport(vault, true)).catch(() => {});
  }

  // Candles — invalidate every interval keyed under this vault.
  for (const [key, entry] of candlesCache.entries()) {
    if (!key.startsWith(`${vault}|`)) continue;
    const [, interval, limitStr] = key.split('|');
    const limit = parseInt(limitStr, 10) || 300;
    entry.fetchedAt = 0;
    entry.error = null;
    startFetch(entry, () => fetchCandles(vault, interval, limit, true)).catch(() => {});
  }
}

// ─── Hook: useReport ────────────────────────────────────────────────────────
export interface UseReportResult {
  data: ReportData | null;
  loading: boolean;        // true only on first load (no data yet)
  syncing: boolean;        // background refresh in flight
  error: string | null;
  refresh: () => void;     // force refresh
}

export function useReport(vault: string | null | undefined): UseReportResult {
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  useEffect(() => {
    if (!vault) return;
    const entry = getOrCreate(reportCache, vault);
    entry.subscribers.add(rerender);

    const isFresh = entry.fetchedAt > 0 && Date.now() - entry.fetchedAt < FRESH_TTL_MS;
    if (!isFresh && !entry.inflight) {
      startFetch(entry, () => fetchReport(vault, false)).catch(() => {});
    }

    return () => {
      entry.subscribers.delete(rerender);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);

  if (!vault) {
    return { data: null, loading: false, syncing: false, error: null, refresh: () => {} };
  }
  const entry = getOrCreate(reportCache, vault);
  return {
    data: entry.data,
    loading: !entry.data && !!entry.inflight,
    syncing: !!entry.inflight,
    error: entry.error,
    refresh: () => {
      startFetch(entry, () => fetchReport(vault, true)).catch(() => {});
    },
  };
}

// ─── Hook: useCandles ───────────────────────────────────────────────────────
export interface UseCandlesResult {
  data: CandlesData | null;
  loading: boolean;
  syncing: boolean;
  error: string | null;
  refresh: () => void;
}

export function useCandles(
  vault: string | null | undefined,
  interval: string,
  limit = 300,
): UseCandlesResult {
  const key = vault ? `${vault}|${interval}|${limit}` : '';
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  useEffect(() => {
    if (!vault) return;
    const entry = getOrCreate(candlesCache, key);
    entry.subscribers.add(rerender);

    const isFresh = entry.fetchedAt > 0 && Date.now() - entry.fetchedAt < FRESH_TTL_MS;
    if (!isFresh && !entry.inflight) {
      startFetch(entry, () => fetchCandles(vault, interval, limit, false)).catch(() => {});
    }

    return () => {
      entry.subscribers.delete(rerender);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!vault) {
    return { data: null, loading: false, syncing: false, error: null, refresh: () => {} };
  }
  const entry = getOrCreate(candlesCache, key);
  return {
    data: entry.data,
    loading: !entry.data && !!entry.inflight,
    syncing: !!entry.inflight,
    error: entry.error,
    refresh: () => {
      startFetch(entry, () => fetchCandles(vault, interval, limit, true)).catch(() => {});
    },
  };
}
