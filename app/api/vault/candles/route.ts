/**
 * GET /api/vault/candles?vault=<pubkey>&interval=<1m|5m|15m|1h|4h|1d>&limit=<N>
 *
 * Returns OHLCV candles aggregated from on-chain BuyEvent / SellEvent.
 * Mirrors the API surface of HyperVapor's TheGraph subgraph
 * (`getCandles(vault, interval, limit)`) so the frontend code is identical.
 *
 * Caching strategy (matches HyperVapor's 2-minute candlesCache):
 *   - In-memory Map keyed by vault address holds full trade history + cursor.
 *   - On request, if last sync was > 2 min ago, do an incremental sync
 *     (only fetch signatures NEWER than the last cursor).
 *   - Candles are rebucketed from cached trades on every request — cheap.
 *
 * Survives across all client tabs since it lives in the Next.js server
 * process (vs. localStorage which is per-tab).
 */

import { NextResponse } from 'next/server';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';

import { CONFIG } from '@/lib/contracts/config';
import { getProgram } from '@/lib/contracts/margin';
import {
  fetchVaultTrades,
  mergeTrades,
  buildCandlesFromTrades,
  intervalToSeconds,
  SUPPORTED_INTERVALS,
  type VaultTrade,
  type Interval,
} from '@/lib/vault-events';

export const dynamic = 'force-dynamic';

// ─── Server-side cache ──────────────────────────────────────────────────────
interface VaultCacheEntry {
  trades: VaultTrade[];
  latestSig: string | null;
  lastSync: number;       // ms
  syncing?: Promise<void>; // in-flight sync (so concurrent requests share)
}

const SYNC_TTL_MS = 2 * 60 * 1000;        // 2 min — same as HyperVapor candlesCache
const tradeCache = new Map<string, VaultCacheEntry>();

// ─── Lazy connection / program (per-process singletons) ────────────────────
let _conn: Connection | null = null;
function getConn(): Connection {
  if (!_conn) _conn = new Connection(CONFIG.rpcUrl, 'confirmed');
  return _conn;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _program: anchor.Program | null = null;
function getReadProgram(): anchor.Program {
  if (_program) return _program;
  const provider = new anchor.AnchorProvider(
    getConn(),
    {
      publicKey: PublicKey.default,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs,
    },
    { commitment: 'confirmed' },
  );
  _program = getProgram(provider);
  return _program;
}

// ─── Sync logic (cache-aware, single-flight per vault) ─────────────────────
async function ensureFreshTrades(vaultStr: string): Promise<VaultCacheEntry> {
  let entry = tradeCache.get(vaultStr);
  const now = Date.now();

  // Cache hit and fresh → return immediately
  if (entry && now - entry.lastSync < SYNC_TTL_MS && !entry.syncing) {
    return entry;
  }

  // If a sync is already in flight, await it
  if (entry?.syncing) {
    await entry.syncing;
    return tradeCache.get(vaultStr)!;
  }

  // Kick off a sync, mark in-flight so concurrent requests dedupe
  if (!entry) {
    entry = { trades: [], latestSig: null, lastSync: 0 };
    tradeCache.set(vaultStr, entry);
  }

  const syncPromise = (async () => {
    const since = entry!.latestSig ?? undefined;
    try {
      const { trades: newTrades, latestSig } = await fetchVaultTrades(
        getConn(),
        getReadProgram(),
        new PublicKey(vaultStr),
        { signatureLimit: since ? 200 : 500, since },
      );

      entry!.trades = mergeTrades(entry!.trades, newTrades);
      entry!.latestSig = latestSig ?? entry!.latestSig;
      entry!.lastSync = Date.now();
    } catch (e) {
      console.error('[api/vault/candles] sync error for', vaultStr, e);
      // Don't update lastSync — let the next request retry
    } finally {
      delete entry!.syncing;
    }
  })();

  entry.syncing = syncPromise;
  await syncPromise;
  return entry;
}

// ─── Handler ────────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const vault = url.searchParams.get('vault');
    const intervalParam = (url.searchParams.get('interval') ?? '15m') as Interval;
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') ?? '300', 10), 1),
      1000,
    );

    if (!vault) {
      return NextResponse.json({ error: 'missing `vault` param' }, { status: 400 });
    }

    let vaultPk: PublicKey;
    try {
      vaultPk = new PublicKey(vault);
    } catch {
      return NextResponse.json({ error: 'invalid vault pubkey' }, { status: 400 });
    }

    if (!SUPPORTED_INTERVALS.includes(intervalParam)) {
      return NextResponse.json(
        { error: `invalid interval; must be one of ${SUPPORTED_INTERVALS.join(', ')}` },
        { status: 400 },
      );
    }

    const entry = await ensureFreshTrades(vaultPk.toBase58());
    const intervalSecs = intervalToSeconds(intervalParam);
    const allCandles = buildCandlesFromTrades(entry.trades, intervalSecs);
    const candles = allCandles.slice(-limit); // newest `limit` candles

    return NextResponse.json(
      {
        vault: vaultPk.toBase58(),
        interval: intervalParam,
        tradeCount: entry.trades.length,
        candles,
        lastSync: entry.lastSync,
      },
      {
        headers: {
          // Match the 2-min server cache so browsers/CDNs can also cache.
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
        },
      },
    );
  } catch (e) {
    console.error('[api/vault/candles] handler error:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal error' },
      { status: 500 },
    );
  }
}
