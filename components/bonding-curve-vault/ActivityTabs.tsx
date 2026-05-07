'use client';

/**
 * ActivityTabs — bottom panel below the chart on the trading tab.
 *
 * Mirrors HyperVapor's `ChartSection` activity log: tab row + scrollable
 * table for History (vault buy/sell trades) and Holders. Drops the L1
 * Trades sub-tab since there's no Hyperliquid on Solana.
 *
 * Data source: /api/vault/report — same server-side cache used by
 * ReportPanel, so opening the report tab and the trading tab won't
 * trigger duplicate RPC scans.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, ExternalLink } from 'lucide-react';
import { getExplorerUrl } from '@/lib/contracts/config';

// ─── Types (mirror /api/vault/report response) ─────────────────────────────
interface TradeRow {
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

interface HolderRow {
  owner: string;
  balance: number;
  percent: number;
}

interface ReportData {
  vault: string;
  lastSync: number;
  meta: { symbol: string; name: string; tokenMint: string; decimals: number } | null;
  summary: {
    totalTrades: number;
    uniqueHolders: number;
    [k: string]: unknown;
  };
  topHolders: HolderRow[];
  recentTrades: TradeRow[];
}

type Tab = 'history' | 'holders';

// ─── Component ──────────────────────────────────────────────────────────────
export default function ActivityTabs({
  vaultAddress,
  leaderAddress,
}: {
  vaultAddress: string;
  leaderAddress?: string;
}) {
  const [tab, setTab] = useState<Tab>('history');
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/vault/report?vault=${vaultAddress}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setData((await res.json()) as ReportData);
    } catch (e) {
      console.error('[ActivityTabs] load error:', e);
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, [vaultAddress]);

  useEffect(() => { load(); }, [load]);

  const symbol = data?.meta?.symbol ?? '';
  const trades = data?.recentTrades ?? [];
  const holders = data?.topHolders ?? [];
  const holderCount = data?.summary?.uniqueHolders ?? 0;
  const tradeCount = data?.summary?.totalTrades ?? 0;

  return (
    <div className="flex-1 border-t border-border bg-black flex flex-col min-h-[200px] lg:min-h-0 overflow-hidden">
      {/* Tab bar — matches HyperVapor: "Vault:" prefix + tabs */}
      <div className="h-10 border-b border-border flex px-2 md:px-4 items-center gap-2 md:gap-4 shrink-0 overflow-x-auto">
        <span className="text-[10px] text-gray-600 font-bold uppercase tracking-widest hidden md:inline">
          Vault:
        </span>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
          History {tradeCount ? `(${tradeCount})` : ''}
        </TabButton>
        <TabButton active={tab === 'holders'} onClick={() => setTab('holders')}>
          Holders ({holderCount})
        </TabButton>
        <div className="ml-auto flex items-center gap-2">
          {loading && (
            <span className="text-[10px] text-gray-500 flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" /> syncing
            </span>
          )}
          {error && (
            <button
              onClick={load}
              className="text-[10px] text-red-400 hover:text-red-300"
              title={error}
            >
              ⚠ retry
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && !data ? (
          <div className="flex justify-center py-10">
            <Loader2 size={24} className="animate-spin text-primary" />
          </div>
        ) : tab === 'history' ? (
          <HistoryTable trades={trades} symbol={symbol} />
        ) : (
          <HoldersTable
            holders={holders}
            symbol={symbol}
            leaderAddress={leaderAddress}
          />
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// History — Vault buy/sell list
// ────────────────────────────────────────────────────────────────────────────
function HistoryTable({ trades, symbol }: { trades: TradeRow[]; symbol: string }) {
  if (trades.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-gray-500 text-sm">No trades yet</p>
      </div>
    );
  }

  return (
    <>
      {/* Mobile: compact rows */}
      <div className="md:hidden divide-y divide-gray-800/50">
        {trades.map((t) => (
          <div
            key={`${t.signature}:${t.side}`}
            className="flex items-center justify-between text-[10px] px-2 py-1"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`font-bold ${t.side === 'buy' ? 'text-primary' : 'text-red-400'}`}>
                {t.side === 'buy' ? 'B' : 'S'}
              </span>
              <span className="text-white font-mono">{shortAddr(t.user)}</span>
              <span className="text-gray-500">${t.usdc.toFixed(2)}</span>
              <span className="text-gray-600">@${t.price.toFixed(4)}</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-gray-500 whitespace-nowrap">
                {formatTime(t.timestamp, true)}
              </span>
              <a
                href={getExplorerUrl('tx', t.signature)}
                target="_blank"
                rel="noreferrer"
                className="text-gray-500 hover:text-primary"
              >
                <ExternalLink size={10} />
              </a>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: HyperVapor-style dense table — TIME first, Buy/Sell color, monospace */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="text-gray-500 border-b border-white/10 sticky top-0 bg-black z-10">
            <tr className="text-[10px] uppercase tracking-widest">
              <th className="text-left px-4 py-2 font-bold">Time</th>
              <th className="text-left px-4 py-2 font-bold">Side</th>
              <th className="text-left px-4 py-2 font-bold">User</th>
              <th className="text-right px-4 py-2 font-bold">Price</th>
              <th className="text-right px-4 py-2 font-bold">USDC</th>
              <th className="text-right px-4 py-2 font-bold">{symbol || 'Tokens'}</th>
              <th className="text-center px-4 py-2 font-bold">Tx</th>
            </tr>
          </thead>
          <tbody className="text-gray-400">
            {trades.map((t) => (
              <tr
                key={`${t.signature}:${t.side}`}
                className="border-b border-white/5 hover:bg-white/5 transition-colors"
              >
                <td className="px-4 py-1.5 text-gray-500 whitespace-nowrap">
                  {formatTime(t.timestamp, true)}
                </td>
                <td
                  className={`px-4 py-1.5 font-bold capitalize ${
                    t.side === 'buy' ? 'text-primary' : 'text-red-400'
                  }`}
                >
                  {t.side}
                </td>
                <td className="px-4 py-1.5">
                  <a
                    href={getExplorerUrl('account', t.user)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-white hover:text-primary cursor-pointer"
                  >
                    {shortAddr(t.user)}
                  </a>
                </td>
                <td className="px-4 py-1.5 text-right text-white font-bold">
                  ${t.price.toFixed(4)}
                </td>
                <td className="px-4 py-1.5 text-right">${t.usdc.toFixed(2)}</td>
                <td className="px-4 py-1.5 text-right">{t.tokens.toFixed(4)}</td>
                <td className="px-4 py-1.5 text-center">
                  <a
                    href={getExplorerUrl('tx', t.signature)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-gray-500 hover:text-primary cursor-pointer inline-flex items-center"
                    title={t.signature}
                  >
                    <ExternalLink size={11} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Holders — token holder list
// ────────────────────────────────────────────────────────────────────────────
function HoldersTable({
  holders,
  symbol,
  leaderAddress,
}: {
  holders: HolderRow[];
  symbol: string;
  leaderAddress?: string;
}) {
  if (holders.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-gray-500 text-sm">No holders yet</p>
      </div>
    );
  }

  return (
    <>
      {/* Mobile */}
      <div className="md:hidden divide-y divide-gray-800/50">
        {holders.map((h, i) => {
          const isLeader = leaderAddress && h.owner === leaderAddress;
          return (
            <div
              key={h.owner}
              className="flex items-center justify-between text-[10px] px-2 py-1"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-gray-600 w-4 text-right">{i + 1}</span>
                <a
                  href={getExplorerUrl('account', h.owner)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-white font-mono hover:text-primary"
                >
                  {shortAddr(h.owner)}
                </a>
                {isLeader && (
                  <span className="px-1 py-0.5 text-[8px] font-bold bg-primary/20 text-primary border border-primary/30">
                    L
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-gray-400 font-mono">{h.balance.toFixed(2)}</span>
                <span className="text-cyan-300 font-bold w-12 text-right">
                  {h.percent.toFixed(2)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop — dense table style matching History */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="text-gray-500 border-b border-white/10 sticky top-0 bg-black z-10">
            <tr className="text-[10px] uppercase tracking-widest">
              <th className="text-left px-4 py-2 font-bold w-12">#</th>
              <th className="text-left px-4 py-2 font-bold">Holder</th>
              <th className="text-right px-4 py-2 font-bold">{symbol || 'Balance'}</th>
              <th className="text-right px-4 py-2 font-bold">% Supply</th>
            </tr>
          </thead>
          <tbody className="text-gray-400">
            {holders.map((h, i) => {
              const isLeader = leaderAddress && h.owner === leaderAddress;
              return (
                <tr
                  key={h.owner}
                  className="border-b border-white/5 hover:bg-white/5 transition-colors"
                >
                  <td className="px-4 py-1.5 text-gray-500">{i + 1}</td>
                  <td className="px-4 py-1.5">
                    <div className="flex items-center gap-2">
                      <a
                        href={getExplorerUrl('account', h.owner)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-white hover:text-primary cursor-pointer"
                      >
                        {shortAddr(h.owner)}
                      </a>
                      {isLeader && (
                        <span className="px-1 py-0 text-[9px] font-bold bg-primary/20 text-primary border border-primary/30 uppercase tracking-widest">
                          L
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-1.5 text-right text-white">
                    {h.balance.toFixed(4)}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <div className="inline-flex items-center justify-end gap-2">
                      <div className="hidden lg:block w-24 h-1.5 bg-white/5 overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${Math.min(100, h.percent)}%`, opacity: 0.7 }}
                        />
                      </div>
                      <span className="text-cyan-300 font-bold w-14 text-right">
                        {h.percent.toFixed(2)}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] md:text-sm font-black uppercase cursor-pointer h-full tracking-widest transition-colors whitespace-nowrap ${
        active
          ? 'text-primary border-b-2 border-primary'
          : 'text-gray-500 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function formatTime(ts: number, compact = false): string {
  const d = new Date(ts * 1000);
  if (compact) {
    return d.toLocaleString('en-CA', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return d.toLocaleString();
}
