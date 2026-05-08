'use client';

/**
 * ActivityTabs — bottom panel below the chart on the trading tab.
 *
 * Mirrors HyperVapor's `ChartSection` activity log: tab row + scrollable
 * tables for History (vault buy/sell), Holders, and Drift (leader's
 * margin trades on Drift via the program's CPI — the Solana counterpart
 * to HyperVapor's "L1 Trades" sub-tab).
 *
 * Data source: shared client-side SWR cache (lib/vault-data-cache.ts) —
 * cache is keyed by vault address and shared with SimulationPanel, so
 * switching tabs doesn't refetch. After a trade, page.tsx calls
 * invalidateVault() which force-refreshes the server cache too.
 */

import { useState } from 'react';
import { Loader2, ExternalLink } from 'lucide-react';
import { getExplorerUrl } from '@/lib/contracts/config';
import {
  useReport,
  type ReportTrade as TradeRow,
  type ReportHolder as HolderRow,
  type ReportMarginTrade as MarginRow,
} from '@/lib/vault-data-cache';

// Drift perp market index → symbol (mirrors KNOWN_MARKETS in lib/drift/api.ts)
const MARKET_SYMBOL: Record<number, string> = {
  0: 'SOL-PERP', 1: 'BTC-PERP', 2: 'ETH-PERP', 3: 'APT-PERP',
  4: '1MBONK-PERP', 5: 'MATIC-PERP', 6: 'ARB-PERP', 7: 'DOGE-PERP',
  8: 'BNB-PERP', 9: 'SUI-PERP', 10: '1MPEPE-PERP', 11: 'OP-PERP',
  12: 'RNDR-PERP', 13: 'XRP-PERP', 14: 'HNT-PERP', 15: 'INJ-PERP',
  16: 'LINK-PERP', 17: 'RLB-PERP', 18: 'PYTH-PERP', 19: 'TIA-PERP',
  20: 'JTO-PERP', 21: 'SEI-PERP', 22: 'AVAX-PERP', 23: 'WIF-PERP',
  24: 'JUP-PERP', 25: 'DYM-PERP', 26: 'TAO-PERP', 27: 'W-PERP',
  28: 'KMNO-PERP', 29: 'TNSR-PERP',
};

type Tab = 'history' | 'holders' | 'drift';

// ─── Component ──────────────────────────────────────────────────────────────
export default function ActivityTabs({
  vaultAddress,
  leaderAddress,
}: {
  vaultAddress: string;
  leaderAddress?: string;
}) {
  const [tab, setTab] = useState<Tab>('history');
  const { data, loading, syncing, error, refresh } = useReport(vaultAddress);

  const symbol = data?.meta?.symbol ?? '';
  const trades = data?.recentTrades ?? [];
  const holders = data?.topHolders ?? [];
  const marginTrades = data?.marginTrades ?? [];
  const holderCount = data?.summary?.uniqueHolders ?? 0;
  const tradeCount = data?.summary?.totalTrades ?? 0;
  const marginCount = data?.summary?.totalMarginTrades ?? 0;

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
        <span className="text-[10px] text-gray-700 hidden md:inline">|</span>
        <span className="text-[10px] text-gray-600 font-bold uppercase tracking-widest hidden md:inline">
          Drift:
        </span>
        <TabButton active={tab === 'drift'} onClick={() => setTab('drift')} accent="purple">
          Trades {marginCount ? `(${marginCount})` : ''}
        </TabButton>
        <div className="ml-auto flex items-center gap-2">
          {syncing && (
            <span className="text-[10px] text-gray-500 flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" /> syncing
            </span>
          )}
          {error && (
            <button
              onClick={refresh}
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
        ) : tab === 'holders' ? (
          <HoldersTable
            holders={holders}
            symbol={symbol}
            leaderAddress={leaderAddress}
          />
        ) : (
          <DriftTradesTable trades={marginTrades} />
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

      {/* Desktop: HyperVapor-style dense table — Buy/Sell color, monospace */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="text-gray-500 border-b border-white/10 sticky top-0 bg-black z-10">
            <tr className="text-[10px] uppercase tracking-widest">
              <th className="text-left px-4 py-2 font-bold">User</th>
              <th className="text-left px-4 py-2 font-bold">Type</th>
              <th className="text-right px-4 py-2 font-bold">USDC</th>
              <th className="text-right px-4 py-2 font-bold">{symbol || 'Tokens'}</th>
              <th className="text-right px-4 py-2 font-bold">Price</th>
              <th className="text-right px-4 py-2 font-bold">Exit Fee</th>
              <th className="text-right px-4 py-2 font-bold">Time</th>
              <th className="text-center px-4 py-2 font-bold">Tx</th>
            </tr>
          </thead>
          <tbody className="text-gray-400">
            {trades.map((t) => {
              const totalFee = t.exitFee + t.perfFee;
              return (
                <tr
                  key={`${t.signature}:${t.side}`}
                  className="border-b border-white/5 hover:bg-white/5 transition-colors"
                >
                  <td className="px-4 py-1.5">
                    <a
                      href={getExplorerUrl('account', t.user)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white hover:text-primary cursor-pointer font-bold"
                    >
                      {shortAddr(t.user)}
                    </a>
                  </td>
                  <td
                    className={`px-4 py-1.5 font-bold uppercase ${
                      t.side === 'buy' ? 'text-primary' : 'text-red-400'
                    }`}
                  >
                    {t.side}
                  </td>
                  <td className="px-4 py-1.5 text-right">${t.usdc.toFixed(2)}</td>
                  <td className="px-4 py-1.5 text-right">{t.tokens.toFixed(4)}</td>
                  <td className="px-4 py-1.5 text-right text-white font-bold">
                    ${t.price.toFixed(6)}
                  </td>
                  <td
                    className="px-4 py-1.5 text-right text-amber-400"
                    title={
                      t.side === 'sell'
                        ? `exit ${t.exitFee.toFixed(4)} + perf ${t.perfFee.toFixed(4)} USDC`
                        : undefined
                    }
                  >
                    {t.side === 'sell' && totalFee > 0 ? `$${totalFee.toFixed(4)}` : '-'}
                  </td>
                  <td className="px-4 py-1.5 text-right text-gray-500 whitespace-nowrap">
                    {formatTime(t.timestamp)}
                  </td>
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
              );
            })}
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

// ────────────────────────────────────────────────────────────────────────────
// Drift trades — leader's perp opens/closes via vault CPI
// ────────────────────────────────────────────────────────────────────────────
function DriftTradesTable({ trades }: { trades: MarginRow[] }) {
  if (trades.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-gray-500 text-sm">No Drift trades yet</p>
        <p className="text-gray-600 text-[10px] mt-1 font-mono">
          Leader's margin trades will appear here once they open a position.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Mobile: compact rows */}
      <div className="md:hidden divide-y divide-gray-800/50">
        {trades.map((t) => {
          const sym = MARKET_SYMBOL[t.marketIndex] ?? `MKT-${t.marketIndex}`;
          const isOpen = t.side === 'open';
          return (
            <div
              key={`${t.signature}:${t.side}`}
              className="flex items-center justify-between text-[10px] px-2 py-1"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className={`font-bold ${
                    isOpen
                      ? t.direction === 'long' ? 'text-primary' : 'text-red-400'
                      : 'text-purple-400'
                  }`}
                >
                  {isOpen ? (t.direction === 'long' ? 'L' : 'S') : 'C'}
                </span>
                <span className="text-white font-mono">{sym}</span>
                {isOpen ? (
                  <span className="text-gray-500">${t.usdcCollateral.toFixed(2)}</span>
                ) : (
                  <span className={t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                    {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                  </span>
                )}
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
          );
        })}
      </div>

      {/* Desktop: dense HyperVapor-style table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="text-gray-500 border-b border-white/10 sticky top-0 bg-black z-10">
            <tr className="text-[10px] uppercase tracking-widest">
              <th className="text-left px-4 py-2 font-bold">Time</th>
              <th className="text-left px-4 py-2 font-bold">Market</th>
              <th className="text-left px-4 py-2 font-bold">Side</th>
              <th className="text-right px-4 py-2 font-bold">Size</th>
              <th className="text-right px-4 py-2 font-bold">Collateral</th>
              <th className="text-right px-4 py-2 font-bold">USDC Out</th>
              <th className="text-right px-4 py-2 font-bold">PnL</th>
              <th className="text-center px-4 py-2 font-bold">Tx</th>
            </tr>
          </thead>
          <tbody className="text-gray-400">
            {trades.map((t) => {
              const sym = MARKET_SYMBOL[t.marketIndex] ?? `MKT-${t.marketIndex}`;
              const isOpen = t.side === 'open';
              const sideLabel = isOpen
                ? (t.direction === 'long' ? 'Long' : 'Short')
                : 'Close';
              const sideColor = isOpen
                ? (t.direction === 'long' ? 'text-primary' : 'text-red-400')
                : 'text-purple-400';
              return (
                <tr
                  key={`${t.signature}:${t.side}`}
                  className="border-b border-white/5 hover:bg-white/5 transition-colors"
                >
                  <td className="px-4 py-1.5 text-gray-500 whitespace-nowrap">
                    {formatTime(t.timestamp)}
                  </td>
                  <td className="px-4 py-1.5 text-white font-bold">{sym}</td>
                  <td className={`px-4 py-1.5 font-bold uppercase ${sideColor}`}>
                    {sideLabel}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {isOpen ? t.baseAmount.toFixed(4) : '-'}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {isOpen ? `$${t.usdcCollateral.toFixed(2)}` : '-'}
                  </td>
                  <td className="px-4 py-1.5 text-right text-cyan-300">
                    {!isOpen ? `$${t.usdcReturned.toFixed(2)}` : '-'}
                  </td>
                  <td
                    className={`px-4 py-1.5 text-right font-bold ${
                      isOpen
                        ? 'text-gray-600'
                        : t.pnl >= 0
                        ? 'text-green-400'
                        : 'text-red-400'
                    }`}
                  >
                    {isOpen
                      ? '-'
                      : `${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`}
                  </td>
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
  accent,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  accent?: 'purple';
}) {
  const activeColor =
    accent === 'purple'
      ? 'text-purple-400 border-purple-400'
      : 'text-primary border-primary';
  return (
    <button
      onClick={onClick}
      className={`text-[10px] md:text-sm font-black uppercase cursor-pointer h-full tracking-widest transition-colors whitespace-nowrap ${
        active
          ? `${activeColor} border-b-2`
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
