'use client';

/**
 * ReportPanel — vault trading report. Fetches /api/vault/report and renders
 * a HyperVapor-style report layout: performance grid, NAV chart, recent
 * trades, top holders.
 *
 * Pure-Solana — no L1 / Hyperliquid concepts.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { Loader2, RefreshCw, ExternalLink } from 'lucide-react';

import { getExplorerUrl } from '@/lib/contracts/config';

// ─── API response types ─────────────────────────────────────────────────────
interface ReportSummary {
  totalTrades: number;
  buyCount: number;
  sellCount: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  netFlow: number;
  uniqueTraders: number;
  uniqueHolders: number;
  tokenSupply: number;
  vaultAgeDays: number;
  firstTradeTime: number;
  lastTradeTime: number;
  openPrice: number;
  lastPrice: number;
  priceChangeAllTime: number;
  priceChange24h: number;
  highPrice24h: number;
  lowPrice24h: number;
  avgTradeSize: number;
}

interface HolderRow {
  owner: string;
  balance: number;
  percent: number;
}

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

interface ReportData {
  vault: string;
  lastSync: number;
  meta: { symbol: string; name: string; tokenMint: string; decimals: number } | null;
  summary: ReportSummary;
  topHolders: HolderRow[];
  recentTrades: TradeRow[];
  navHistory: { time: number; value: number }[];
}

// ─── Component ──────────────────────────────────────────────────────────────
export default function ReportPanel({ vaultAddress }: { vaultAddress: string }) {
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
      const json = (await res.json()) as ReportData;
      setData(json);
    } catch (e) {
      console.error('[ReportPanel] load error:', e);
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, [vaultAddress]);

  useEffect(() => { load(); }, [load]);

  // Loading
  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64 bg-card border border-border">
        <Loader2 className="animate-spin text-primary" size={28} />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 bg-card border border-border gap-2">
        <p className="text-red-400 text-sm font-mono">{error}</p>
        <button onClick={load} className="text-primary text-xs hover:underline">
          Retry
        </button>
      </div>
    );
  }
  if (!data) return null;

  const { summary, topHolders, recentTrades, navHistory, meta } = data;
  const sym = meta?.symbol ?? 'TOKEN';

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black uppercase italic text-white">
            Trading Report
          </h2>
          <p className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">
            {meta?.name ? `${meta.name} · $${sym}` : sym}
            {' · last sync '}
            {new Date(data.lastSync).toLocaleTimeString()}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="p-2 border border-border hover:bg-primary/10 hover:border-primary text-gray-400 hover:text-primary disabled:opacity-40 transition-colors"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Performance grid (mirrors HyperVapor SimulationPanel report mode) */}
      <Section title="Performance">
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-px bg-border">
          <Metric label="Last Price" value={`$${summary.lastPrice.toFixed(4)}`} accent="text-white" />
          <Metric
            label="24h"
            value={`${summary.priceChange24h >= 0 ? '+' : ''}${summary.priceChange24h.toFixed(2)}%`}
            accent={summary.priceChange24h >= 0 ? 'text-green-400' : 'text-red-400'}
          />
          <Metric
            label="All Time"
            value={`${summary.priceChangeAllTime >= 0 ? '+' : ''}${summary.priceChangeAllTime.toFixed(2)}%`}
            accent={summary.priceChangeAllTime >= 0 ? 'text-green-400' : 'text-red-400'}
          />
          <Metric label="24h High" value={`$${summary.highPrice24h.toFixed(4)}`} accent="text-cyan-300" />
          <Metric label="24h Low" value={`$${summary.lowPrice24h.toFixed(4)}`} accent="text-amber-300" />

          <Metric label="Total Volume" value={`$${formatNum(summary.totalVolume)}`} accent="text-white" />
          <Metric label="Buy Vol" value={`$${formatNum(summary.buyVolume)}`} accent="text-green-400" />
          <Metric label="Sell Vol" value={`$${formatNum(summary.sellVolume)}`} accent="text-red-400" />
          <Metric
            label="Net Flow"
            value={`${summary.netFlow >= 0 ? '+' : ''}$${formatNum(summary.netFlow)}`}
            accent={summary.netFlow >= 0 ? 'text-green-400' : 'text-red-400'}
          />
          <Metric label="Avg Trade" value={`$${formatNum(summary.avgTradeSize)}`} accent="text-white" />

          <Metric label="Trades" value={summary.totalTrades.toString()} accent="text-white" />
          <Metric label="Buys" value={summary.buyCount.toString()} accent="text-green-400" />
          <Metric label="Sells" value={summary.sellCount.toString()} accent="text-red-400" />
          <Metric label="Holders" value={summary.uniqueHolders.toString()} accent="text-cyan-300" />
          <Metric label="Age" value={`${summary.vaultAgeDays.toFixed(1)}d`} accent="text-white" />
        </div>
      </Section>

      {/* NAV history chart */}
      {navHistory.length >= 2 && (
        <Section title="NAV History">
          <div className="h-48 bg-black/40 border border-white/5 p-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={navHistory.map((p) => ({
                t: p.time,
                v: p.value,
                label: new Date(p.time * 1000).toLocaleString(),
              }))}>
                <defs>
                  <linearGradient id="nav-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#00d4aa" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#00d4aa" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="t"
                  tickFormatter={(t) => {
                    const d = new Date(t * 1000);
                    return `${d.getMonth() + 1}/${d.getDate()}`;
                  }}
                  stroke="#6b7280"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#6b7280"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `$${Number(v).toFixed(3)}`}
                  domain={['dataMin', 'dataMax']}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0a0a0a',
                    border: '1px solid rgba(42, 46, 57, 0.8)',
                    fontSize: 11,
                    fontFamily: 'monospace',
                  }}
                  labelFormatter={(t) => new Date((t as number) * 1000).toLocaleString()}
                  formatter={(v) => [`$${Number(v ?? 0).toFixed(6)}`, 'NAV']}
                />
                <ReferenceLine y={summary.openPrice} stroke="#6b7280" strokeDasharray="3 3" />
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="#00d4aa"
                  strokeWidth={2}
                  fill="url(#nav-grad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Recent trades */}
        <Section title={`Recent Trades (${recentTrades.length})`}>
          {recentTrades.length === 0 ? (
            <div className="p-3 text-[11px] font-mono text-gray-500">
              No trades yet on this vault.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] font-mono">
                <thead>
                  <tr className="text-gray-500 uppercase tracking-widest border-b border-border">
                    <th className="text-left p-2 font-bold">Time</th>
                    <th className="text-left p-2 font-bold">Side</th>
                    <th className="text-right p-2 font-bold">Price</th>
                    <th className="text-right p-2 font-bold">USDC</th>
                    <th className="text-right p-2 font-bold">{sym}</th>
                    <th className="text-right p-2 font-bold">User</th>
                    <th className="text-center p-2 font-bold">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTrades.map((t) => (
                    <tr key={`${t.signature}:${t.side}`} className="border-b border-border/50 hover:bg-white/5">
                      <td className="p-2 text-gray-400 whitespace-nowrap">
                        {new Date(t.timestamp * 1000).toLocaleString('en-CA', {
                          month: '2-digit', day: '2-digit',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </td>
                      <td className="p-2">
                        <span className={t.side === 'buy' ? 'text-green-400' : 'text-red-400'}>
                          {t.side.toUpperCase()}
                        </span>
                      </td>
                      <td className="p-2 text-right text-white font-bold">${t.price.toFixed(4)}</td>
                      <td className="p-2 text-right text-gray-300">{formatNum(t.usdc)}</td>
                      <td className="p-2 text-right text-gray-300">{formatNum(t.tokens)}</td>
                      <td className="p-2 text-right text-gray-500">{shortAddr(t.user)}</td>
                      <td className="p-2 text-center">
                        <a
                          href={getExplorerUrl('tx', t.signature)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:opacity-80"
                          title="View tx"
                        >
                          <ExternalLink size={10} className="inline" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Top holders */}
        <Section title={`Top Holders (${summary.uniqueHolders})`}>
          {topHolders.length === 0 ? (
            <div className="p-3 text-[11px] font-mono text-gray-500">
              No holders yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] font-mono">
                <thead>
                  <tr className="text-gray-500 uppercase tracking-widest border-b border-border">
                    <th className="text-left p-2 font-bold">#</th>
                    <th className="text-left p-2 font-bold">Owner</th>
                    <th className="text-right p-2 font-bold">{sym}</th>
                    <th className="text-right p-2 font-bold">% Supply</th>
                  </tr>
                </thead>
                <tbody>
                  {topHolders.slice(0, 25).map((h, i) => (
                    <tr key={h.owner} className="border-b border-border/50 hover:bg-white/5">
                      <td className="p-2 text-gray-500">{i + 1}</td>
                      <td className="p-2">
                        <a
                          href={getExplorerUrl('account', h.owner)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {shortAddr(h.owner)}
                        </a>
                      </td>
                      <td className="p-2 text-right text-white">{formatNum(h.balance)}</td>
                      <td className="p-2 text-right">
                        <span className="inline-flex items-center gap-1.5">
                          <div
                            className="bg-primary h-1.5"
                            style={{ width: `${Math.min(60, h.percent * 0.6)}px`, opacity: 0.6 }}
                          />
                          <span className="text-cyan-300 font-bold w-12 text-right">
                            {h.percent.toFixed(2)}%
                          </span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────
function Section({
  title,
  children,
}: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border bg-card">
      <div className="px-4 py-2 border-b border-border">
        <div className="text-[10px] font-mono text-primary uppercase tracking-widest font-bold">
          {title}
        </div>
      </div>
      {children}
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: { label: string; value: string; accent: string }) {
  return (
    <div className="bg-black/60 px-3 py-2.5">
      <div className="text-[9px] font-mono text-gray-500 uppercase tracking-widest mb-0.5">
        {label}
      </div>
      <div className={`font-mono text-sm font-bold ${accent} truncate`}>{value}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (Math.abs(n) >= 1) return n.toFixed(2);
  if (n === 0) return '0';
  return n.toFixed(4);
}

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}
