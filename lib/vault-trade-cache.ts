/**
 * Server-side trade cache shared by /api/vault/candles and /api/vault/report.
 *
 * In-memory Map keyed by vault address. Each entry holds the full trade
 * history + a cursor; on cache miss / expiry, only signatures NEWER than
 * the cursor are fetched (incremental sync).
 *
 * This module is server-only — it imports server-side singletons
 * (Connection / Program) and reuses them across requests.
 */

import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';

import { CONFIG } from '@/lib/contracts/config';
import { getProgram } from '@/lib/contracts/margin';
import {
  fetchVaultTrades,
  mergeTrades,
  type VaultTrade,
} from '@/lib/vault-events';

// ─── Cache shape ────────────────────────────────────────────────────────────
export interface VaultCacheEntry {
  trades: VaultTrade[];
  latestSig: string | null;
  lastSync: number;          // ms — 0 means never synced
  syncing?: Promise<void>;   // in-flight sync (so concurrent requests share)
}

export const SYNC_TTL_MS = 2 * 60 * 1000;        // 2 min — same as HyperVapor candlesCache
const tradeCache = new Map<string, VaultCacheEntry>();

// ─── Lazy singletons (per-process) ──────────────────────────────────────────
let _conn: Connection | null = null;
function getConn(): Connection {
  if (!_conn) _conn = new Connection(CONFIG.rpcUrl, 'confirmed');
  return _conn;
}

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

export function getServerConnection(): Connection {
  return getConn();
}

// ─── Single-flight sync ─────────────────────────────────────────────────────
/**
 * Returns a fresh-enough cache entry for `vaultStr`. Multiple concurrent
 * callers share the same in-flight sync (`entry.syncing`). After success
 * the entry is updated with the merged trades and a new `lastSync`.
 */
export async function ensureFreshTrades(vaultStr: string): Promise<VaultCacheEntry> {
  let entry = tradeCache.get(vaultStr);
  const now = Date.now();

  if (entry && now - entry.lastSync < SYNC_TTL_MS && !entry.syncing) {
    return entry;
  }

  if (entry?.syncing) {
    await entry.syncing;
    return tradeCache.get(vaultStr)!;
  }

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
      console.error('[vault-trade-cache] sync error for', vaultStr, e);
      // Don't update lastSync — let the next request retry
    } finally {
      delete entry!.syncing;
    }
  })();

  entry.syncing = syncPromise;
  await syncPromise;
  return entry;
}
