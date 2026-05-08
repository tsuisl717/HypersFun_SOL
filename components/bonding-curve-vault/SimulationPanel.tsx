'use client';

/**
 * SimulationPanel — vault analytics + what-if simulator (Solana shell).
 *
 * Two modes mirroring HyperVapor-Fun:
 *   • Report mode    — real on-chain data (trades / holders / NAV history)
 *   • Simulation mode — synthetic what-if scenarios (UI-only stub here)
 *
 * Layout matches HyperVapor's screenshot:
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │ Top stats bar (BUYS / SELLS / WINS / LOSSES / APY / NET FLOW)     │
 *   ├──────┬─────────────────────────────────┬──────────────────────────┤
 *   │ Left │ Detailed Results table          │ Contract Settings        │
 *   │ side │ ───────────────────────────     │ - NAV virtual            │
 *   │ +    │ User PnL Tracking table         │ - Graduation tiers       │
 *   │ 3    │                                 │ - Trading fees           │
 *   │ mini │                                 │ - Price limits           │
 *   │ chart│                                 │ - Exit fees              │
 *   │      │                                 │ - Performance            │
 *   │      │                                 │ - Download JSON          │
 *   └──────┴─────────────────────────────────┴──────────────────────────┘
 *
 * All data slots are derived from `/api/vault/report` — no extra RPC.
 * Simulation mode is a placeholder; wire to the program's BC math later.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { Loader2, Download, ExternalLink } from 'lucide-react';
import { getExplorerUrl } from '@/lib/contracts/config';
import { useReport } from '@/lib/vault-data-cache';

// ─── API response (matches /api/vault/report) ──────────────────────────────
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
  };
  topHolders: HolderRow[];
  recentTrades: TradeRow[];
  navHistory: { time: number; value: number }[];
}

// ─── Derived per-trade snapshot (replays supply/assets) ─────────────────────
interface DetailedRow {
  i: number;
  trade: TradeRow;
  supply: number;       // running token supply BEFORE this trade
  supplyAfter: number;  // running token supply AFTER this trade
  assets: number;       // approx. total assets after this trade
  fee: number;          // trading fee approx (1% of usdc)
  slipBps: number;      // slippage vs prev close, basis points
}

interface UserPnl {
  user: string;
  spent: number;        // total USDC put in (buys)
  received: number;     // total USDC out (sells)
  holding: number;      // tokens currently held (from topHolders)
  value: number;        // current $ value of holding
  avgPrice: number;     // weighted avg buy price
  realized: number;     // USDC out - cost basis of sold tokens
  unrealized: number;   // value - cost basis of held tokens
  totalPnl: number;     // realized + unrealized
  roi: number;          // totalPnl / spent
}

// ─── Static defaults (same as page.tsx) — wire to factory later ────────────
const DEFAULT_TIERS = [
  { label: '🔥Seed',      threshold: 100_000,     bcVirtual: 1_000_000,   navMinMul: 0.01, navMaxMul: 0.02, sqBps: 9000 },
  { label: '💎Growth',    threshold: 1_000_000,   bcVirtual: 10_000_000,  navMinMul: 0.1,  navMaxMul: 0.2,  sqBps: 6000 },
  { label: '🏆Mature',    threshold: 10_000_000,  bcVirtual: 20_000_000,  navMinMul: 0.4,  navMaxMul: 0.6,  sqBps: 1500 },
  { label: '👑Graduated', threshold: 100_000_000, bcVirtual: 100_000_000, navMinMul: 0.8,  navMaxMul: 1.2,  sqBps: 200  },
] as const;

const DEFAULT_EXIT_TIERS = [
  { range: '<7D',    feeBps: 1500 },
  { range: '7-30D',  feeBps: 800  },
  { range: '30-90D', feeBps: 300  },
  { range: '>90D',   feeBps: 0    },
] as const;

// ─── Component ──────────────────────────────────────────────────────────────
type Mode = 'report' | 'simulation';
type ChartRange = '7D' | '30D' | '90D' | '1Y';
type ChartType = 'pnl' | 'rate' | 'assets';

export interface SimulationPanelProps {
  vaultAddress: string;
  /** Pre-fetched report data. If omitted, the panel fetches from the API. */
  reportData?: ReportData;
  /** Trading fee bps from factory account (default 100 = 1%) */
  tradingFeeBps?: number;
  /** Performance fee bps (default 2000 = 20%) */
  performanceFeeBps?: number;
  /** Max premium over NAV, bps */
  maxPremiumBps?: number;
  /** Max discount under NAV, bps */
  maxDiscountBps?: number;
  /** NAV virtual multiplier (e.g. 0.01 = 1%) */
  navVirtualMul?: number;
  /** Current vBase / vTokens (raw, divided by 1e6 for display) */
  vBase?: number;
  vTokens?: number;
}

export default function SimulationPanel({
  vaultAddress,
  reportData: externalData,
  tradingFeeBps = 100,
  performanceFeeBps = 2000,
  maxPremiumBps = 10000,
  maxDiscountBps = 5000,
  navVirtualMul = 0.01,
  vBase = 0,
  vTokens = 0,
}: SimulationPanelProps) {
  const [mode, setMode] = useState<Mode>('report');
  const [chartRange, setChartRange] = useState<ChartRange>('30D');
  const [chartType, setChartType] = useState<ChartType>('pnl');

  // Subscribe to the shared report cache (no-op fetch when externalData
  // is provided — we still subscribe so cache stays warm for tab toggles).
  const hookResult = useReport(externalData ? null : vaultAddress);
  const data: ReportData | null = (externalData ?? hookResult.data) as ReportData | null;
  const loading = !externalData && hookResult.loading;
  const error = externalData ? null : hookResult.error;
  const load = hookResult.refresh;

  // ─── Derived: detailed per-trade results ──────────────────────────────
  const detailedResults = useMemo<DetailedRow[]>(() => {
    if (!data) return [];
    const trades = [...data.recentTrades].reverse(); // ascending order
    const rows: DetailedRow[] = [];
    let runningSupply = 0;
    let runningAssets = 0;
    let prevPrice = trades[0]?.price ?? 0;

    trades.forEach((t, i) => {
      const supplyBefore = runningSupply;
      if (t.side === 'buy') {
        runningSupply += t.tokens;
        runningAssets += t.usdc;
      } else {
        runningSupply -= t.tokens;
        runningAssets -= t.usdc;
      }
      const fee = t.usdc * (tradingFeeBps / 10000);
      const slipBps = prevPrice > 0
        ? Math.abs(((t.price - prevPrice) / prevPrice) * 10000)
        : 0;

      rows.push({
        i: i + 1,
        trade: t,
        supply: supplyBefore,
        supplyAfter: runningSupply,
        assets: runningAssets,
        fee,
        slipBps,
      });
      prevPrice = t.price;
    });

    return rows.reverse(); // newest first for the table
  }, [data, tradingFeeBps]);

  // ─── Derived: per-user PnL tracking ───────────────────────────────────
  const userPnls = useMemo<UserPnl[]>(() => {
    if (!data) return [];
    const lastPrice = data.summary.lastPrice;
    const tradesByUser = new Map<string, TradeRow[]>();
    for (const t of data.recentTrades) {
      const arr = tradesByUser.get(t.user) ?? [];
      arr.push(t);
      tradesByUser.set(t.user, arr);
    }
    const holdingMap = new Map<string, number>();
    for (const h of data.topHolders) holdingMap.set(h.owner, h.balance);

    const out: UserPnl[] = [];
    for (const [user, trades] of tradesByUser.entries()) {
      let spent = 0, received = 0;
      let buyTokens = 0, buyCost = 0;
      let soldCost = 0;        // cost basis of sold tokens (FIFO weighted avg)
      for (const t of trades) {
        if (t.side === 'buy') {
          spent += t.usdc;
          buyTokens += t.tokens;
          buyCost += t.usdc;
        } else {
          received += t.usdc;
          // approximate using running average buy price
          const avgBuyPx = buyTokens > 0 ? buyCost / buyTokens : 0;
          soldCost += t.tokens * avgBuyPx;
        }
      }
      const holding = holdingMap.get(user) ?? 0;
      const value = holding * lastPrice;
      const avgPrice = buyTokens > 0 ? buyCost / buyTokens : 0;
      const heldCost = holding * avgPrice;
      const realized = received - soldCost;
      const unrealized = value - heldCost;
      const totalPnl = realized + unrealized;
      const roi = spent > 0 ? totalPnl / spent : 0;
      out.push({
        user, spent, received, holding, value, avgPrice,
        realized, unrealized, totalPnl, roi,
      });
    }
    out.sort((a, b) => b.totalPnl - a.totalPnl);
    return out;
  }, [data]);

  // ─── Derived: PnL history series for the chart ─────────────────────────
  const pnlSeries = useMemo(() => {
    if (!data) return [];
    let cumulative = 0;
    return [...data.recentTrades].reverse().map((t) => {
      cumulative += t.side === 'buy' ? t.usdc : -t.usdc;
      return { time: t.timestamp, value: cumulative };
    });
  }, [data]);

  // ─── Derived: performance metrics ──────────────────────────────────────
  const perf = useMemo(() => {
    if (!data) {
      return { apy: 0, winRate: 0, sharpe: 0, profitFactor: 0, maxDrawdown: 0, netPnl: 0 };
    }
    const navHist = data.navHistory;
    if (navHist.length < 2) {
      return { apy: 0, winRate: 0, sharpe: 0, profitFactor: 0, maxDrawdown: 0, netPnl: data.summary.netFlow };
    }

    // Daily-ish returns from NAV series
    const returns: number[] = [];
    for (let i = 1; i < navHist.length; i++) {
      const prev = navHist[i - 1].value;
      const curr = navHist[i].value;
      if (prev > 0) returns.push((curr - prev) / prev);
    }
    const wins = returns.filter((r) => r > 0);
    const losses = returns.filter((r) => r < 0);
    const winRate = returns.length > 0 ? wins.length / returns.length : 0;
    const grossWins = wins.reduce((s, r) => s + r, 0);
    const grossLosses = Math.abs(losses.reduce((s, r) => s + r, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);

    // Sharpe ≈ mean / stdev of NAV returns, annualised (assume daily granularity)
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

    // Max drawdown on NAV series
    let peak = navHist[0].value;
    let maxDd = 0;
    for (const p of navHist) {
      if (p.value > peak) peak = p.value;
      if (peak > 0) {
        const dd = (peak - p.value) / peak;
        if (dd > maxDd) maxDd = dd;
      }
    }

    // APY from price change over vault age
    const totalReturn = (data.summary.lastPrice - data.summary.openPrice) / Math.max(data.summary.openPrice, 1e-9);
    const ageDays = Math.max(1, data.summary.vaultAgeDays);
    const apy = totalReturn > -0.99
      ? (Math.pow(1 + totalReturn, 365 / ageDays) - 1) * 100
      : totalReturn * 100;

    return {
      apy,
      winRate,
      sharpe,
      profitFactor,
      maxDrawdown: maxDd * 100,
      netPnl: data.summary.netFlow,
    };
  }, [data]);

  const downloadJson = useCallback(() => {
    if (!data) return;
    const payload = { ...data, detailedResults, userPnls, perf };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vault-report-${data.vault.slice(0, 8)}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data, detailedResults, userPnls, perf]);

  // ─── Render: loading / error ──────────────────────────────────────────
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

  const { summary, meta } = data;
  const sym = meta?.symbol ?? 'TOKEN';
  const fees = summary.totalVolume * (tradingFeeBps / 10000);

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="bg-card border border-border">
      {/* ─── Top stats bar ──────────────────────────────────────────── */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-px bg-border border-b border-border">
        <TopStat label="Buys"        value={`${summary.buyCount}x`}    sub={`$${formatNum(summary.buyVolume)}`}    accent="text-primary" />
        <TopStat label="Sells"       value={`${summary.sellCount}x`}   sub={`$${formatNum(summary.sellVolume)}`}   accent="text-red-400" />
        <TopStat label="Trade Wins"  value="0x"                         sub="+$0"                                   accent="text-gray-500" muted />
        <TopStat label="Trade Losses" value="0x"                        sub="-$0"                                   accent="text-gray-500" muted />
        <TopStat label="APY / Win"   value={`${perf.apy.toFixed(1)}%`}  sub={`${(perf.winRate * 100).toFixed(1)}%`} accent={perf.apy >= 0 ? 'text-green-400' : 'text-red-400'} />
        <TopStat label="Net Flow"    value={`${summary.netFlow >= 0 ? '+' : ''}$${formatNum(summary.netFlow)}`} sub={`fees $${formatNum(fees)}`} accent={summary.netFlow >= 0 ? 'text-green-400' : 'text-red-400'} />
      </div>

      {/* ─── Body: 3-column grid ────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-[260px_1fr_280px]">
        {/* ─ Left side panel ──────────────────────────────────────── */}
        <div className="border-b xl:border-b-0 xl:border-r border-border">
          {/* Mode toggle */}
          <div className="flex border-b border-border">
            <ModeBtn active={mode === 'report'}     onClick={() => setMode('report')}     label="Trading" />
            <ModeBtn active={mode === 'simulation'} onClick={() => setMode('simulation')} label="Simulation" />
            <span className="ml-auto px-3 self-center text-lg font-mono font-bold text-white">
              {summary.netFlow >= 0 ? '+' : '-'}${Math.abs(summary.netFlow).toFixed(2)}
            </span>
          </div>

          {/* Metric grid */}
          <div className="grid grid-cols-2 text-[10px]">
            <Cell label="PnL"     value={`${perf.netPnl >= 0 ? '+' : ''}$${formatNum(perf.netPnl)}`} accent={perf.netPnl >= 0 ? 'text-green-400' : 'text-red-400'} />
            <Cell label="APY"     value={`${perf.apy.toFixed(1)}%`} accent={perf.apy >= 0 ? 'text-green-400' : 'text-red-400'} />
            <Cell label="Win Rate" value={`${(perf.winRate * 100).toFixed(1)}%`} accent="text-white" />
            <Cell label="Drawdown" value={`-${perf.maxDrawdown.toFixed(1)}%`} accent="text-red-400" />
            <Cell label="Trades"  value={summary.totalTrades.toString()} accent="text-white" />
            <Cell label="Fees"    value={`$${formatNum(fees)}`} accent="text-amber-300" />
          </div>

          {/* Chart range + type toggles */}
          <div className="flex items-center justify-between p-2 border-t border-border">
            <div className="flex">
              {(['7D', '30D', '90D', '1Y'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setChartRange(r)}
                  className={`px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
                    chartRange === r ? 'bg-primary text-black' : 'text-gray-500 hover:text-white'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <div className="flex">
              <button
                onClick={() => setChartType('rate')}
                className={`px-1.5 py-0.5 text-[10px] font-bold uppercase ${chartType === 'rate' ? 'bg-purple-600 text-white' : 'text-gray-500 hover:text-white'}`}
              >%</button>
              <button
                onClick={() => setChartType('pnl')}
                className={`px-1.5 py-0.5 text-[10px] font-bold uppercase ${chartType === 'pnl' ? 'bg-green-600 text-white' : 'text-gray-500 hover:text-white'}`}
              >$</button>
              <button
                onClick={() => setChartType('assets')}
                className={`px-1.5 py-0.5 text-[10px] font-bold uppercase ${chartType === 'assets' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-white'}`}
              >Assets</button>
            </div>
          </div>

          {/* Mini charts */}
          <MiniChart title="PNL"            data={pnlSeries}        color="#10b981" range={chartRange} />
          <MiniChart title="Assets & Supply" data={data.navHistory.map((p) => ({ time: p.time, value: p.value * summary.tokenSupply }))} color="#3b82f6" range={chartRange} />
          <MiniChart title="NAV & Price"    data={data.navHistory}   color="#10b981" range={chartRange} />
        </div>

        {/* ─ Center: Detailed Results + User PnL ─────────────────── */}
        <div className="border-b xl:border-b-0 xl:border-r border-border">
          {mode === 'simulation' ? (
            <SimulationStub />
          ) : (
            <>
              <DetailedResults rows={detailedResults} symbol={sym} />
              <UserPnlTable users={userPnls} symbol={sym} />
            </>
          )}
        </div>

        {/* ─ Right: Contract Settings ────────────────────────────── */}
        <ContractSettings
          summary={summary}
          perf={perf}
          tradingFeeBps={tradingFeeBps}
          performanceFeeBps={performanceFeeBps}
          maxPremiumBps={maxPremiumBps}
          maxDiscountBps={maxDiscountBps}
          navVirtualMul={navVirtualMul}
          vBase={vBase}
          vTokens={vTokens}
          fees={fees}
          onDownload={downloadJson}
        />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Detailed Results table — per-trade snapshot
// ────────────────────────────────────────────────────────────────────────────
function DetailedResults({
  rows,
  symbol,
}: { rows: DetailedRow[]; symbol: string }) {
  return (
    <div className="border-b border-border">
      <div className="px-3 py-2 border-b border-border">
        <span className="text-[11px] font-black uppercase tracking-widest text-white">
          Detailed Results
        </span>
      </div>
      <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
        <table className="w-full text-[10px] font-mono">
          <thead className="text-gray-500 sticky top-0 bg-card z-10 border-b border-white/10">
            <tr>
              <th className="text-left px-2 py-1.5 font-bold">#</th>
              <th className="text-left px-2 py-1.5 font-bold">Action</th>
              <th className="text-left px-2 py-1.5 font-bold">User</th>
              <th className="text-right px-2 py-1.5 font-bold">Input</th>
              <th className="text-right px-2 py-1.5 font-bold">Tokens</th>
              <th className="text-right px-2 py-1.5 font-bold">USDC Out</th>
              <th className="text-right px-2 py-1.5 font-bold">Fee</th>
              <th className="text-right px-2 py-1.5 font-bold">Slip</th>
              <th className="text-right px-2 py-1.5 font-bold">Assets</th>
              <th className="text-right px-2 py-1.5 font-bold">Supply</th>
              <th className="text-right px-2 py-1.5 font-bold">Raw NAV</th>
              <th className="text-right px-2 py-1.5 font-bold">Stab NAV</th>
              <th className="text-right px-2 py-1.5 font-bold">Price</th>
              <th className="text-center px-2 py-1.5 font-bold">Tx</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={14} className="text-center py-6 text-gray-500">
                  No trades yet
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const t = r.trade;
                const rawNav = r.supply > 0 ? r.assets / r.supply : 0;
                return (
                  <tr key={`${t.signature}:${t.side}`} className="border-b border-white/5 hover:bg-white/5">
                    <td className="px-2 py-1 text-gray-500">{r.i}</td>
                    <td className={`px-2 py-1 font-bold capitalize ${t.side === 'buy' ? 'text-primary' : 'text-red-400'}`}>
                      {t.side}
                    </td>
                    <td className="px-2 py-1">
                      <a
                        href={getExplorerUrl('account', t.user)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-white hover:text-primary"
                      >
                        {shortAddr(t.user)}
                      </a>
                    </td>
                    <td className="px-2 py-1 text-right">
                      {t.side === 'buy' ? `$${t.usdc.toFixed(2)}` : `${t.tokens.toFixed(4)}`}
                    </td>
                    <td className="px-2 py-1 text-right">{t.tokens.toFixed(4)}</td>
                    <td className="px-2 py-1 text-right">
                      {t.side === 'sell' ? `$${t.usdc.toFixed(2)}` : '—'}
                    </td>
                    <td className="px-2 py-1 text-right text-amber-300">${r.fee.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right text-gray-500">
                      {r.slipBps > 0 ? `${(r.slipBps / 100).toFixed(2)}%` : '—'}
                    </td>
                    <td className="px-2 py-1 text-right text-cyan-300">${formatNum(r.assets)}</td>
                    <td className="px-2 py-1 text-right">{formatNum(r.supplyAfter)}</td>
                    <td className="px-2 py-1 text-right text-yellow-400">${rawNav.toFixed(4)}</td>
                    <td className="px-2 py-1 text-right text-orange-400">${t.navRaw.toFixed(4)}</td>
                    <td className="px-2 py-1 text-right text-white font-bold">${t.price.toFixed(4)}</td>
                    <td className="px-2 py-1 text-center">
                      <a
                        href={getExplorerUrl('tx', t.signature)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-gray-500 hover:text-primary inline-flex"
                      >
                        <ExternalLink size={10} />
                      </a>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// User PnL Tracking
// ────────────────────────────────────────────────────────────────────────────
function UserPnlTable({ users, symbol }: { users: UserPnl[]; symbol: string }) {
  return (
    <div>
      <div className="px-3 py-2 border-b border-border">
        <span className="text-[11px] font-black uppercase tracking-widest text-white">
          User PnL Tracking
        </span>
      </div>
      <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
        <table className="w-full text-[10px] font-mono">
          <thead className="text-gray-500 sticky top-0 bg-card z-10 border-b border-white/10">
            <tr>
              <th className="text-left px-2 py-1.5 font-bold">User</th>
              <th className="text-right px-2 py-1.5 font-bold">Spent</th>
              <th className="text-right px-2 py-1.5 font-bold">Received</th>
              <th className="text-right px-2 py-1.5 font-bold">Holding</th>
              <th className="text-right px-2 py-1.5 font-bold">Value</th>
              <th className="text-right px-2 py-1.5 font-bold">Avg Price</th>
              <th className="text-right px-2 py-1.5 font-bold">Realized</th>
              <th className="text-right px-2 py-1.5 font-bold">Unrealized</th>
              <th className="text-right px-2 py-1.5 font-bold">Total PnL</th>
              <th className="text-right px-2 py-1.5 font-bold">ROI</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={10} className="text-center py-6 text-gray-500">
                  No user data
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.user} className="border-b border-white/5 hover:bg-white/5">
                  <td className="px-2 py-1">
                    <a
                      href={getExplorerUrl('account', u.user)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white hover:text-primary"
                    >
                      {shortAddr(u.user)}
                    </a>
                  </td>
                  <td className="px-2 py-1 text-right">${u.spent.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right">{u.received > 0 ? `$${u.received.toFixed(2)}` : '—'}</td>
                  <td className="px-2 py-1 text-right">{u.holding.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right text-cyan-300">${u.value.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right">${u.avgPrice.toFixed(4)}</td>
                  <td className={`px-2 py-1 text-right ${u.realized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {u.realized > 0 ? '+' : ''}${u.realized.toFixed(2)}
                  </td>
                  <td className={`px-2 py-1 text-right ${u.unrealized >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {u.unrealized > 0 ? '+' : ''}${u.unrealized.toFixed(2)}
                  </td>
                  <td className={`px-2 py-1 text-right font-bold ${u.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {u.totalPnl > 0 ? '+' : ''}${u.totalPnl.toFixed(2)}
                  </td>
                  <td className={`px-2 py-1 text-right font-bold ${u.roi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {u.roi > 0 ? '+' : ''}{(u.roi * 100).toFixed(1)}%
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {/* Suppress unused-symbol warning until we tag user balance with the symbol */}
      <div className="hidden">{symbol}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Contract Settings (right column)
// ────────────────────────────────────────────────────────────────────────────
function ContractSettings({
  summary,
  perf,
  tradingFeeBps,
  performanceFeeBps,
  maxPremiumBps,
  maxDiscountBps,
  navVirtualMul,
  vBase,
  vTokens,
  fees,
  onDownload,
}: {
  summary: ReportData['summary'];
  perf: { apy: number; winRate: number; sharpe: number; profitFactor: number; maxDrawdown: number; netPnl: number };
  tradingFeeBps: number;
  performanceFeeBps: number;
  maxPremiumBps: number;
  maxDiscountBps: number;
  navVirtualMul: number;
  vBase: number;
  vTokens: number;
  fees: number;
  onDownload: () => void;
}) {
  return (
    <div className="text-[11px] font-mono">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border">
        <span className="text-[11px] font-black uppercase tracking-widest text-white">
          Contract Settings
        </span>
      </div>

      {/* NAV Virtual */}
      <Block title="NAV Virtual">
        <Row label="Multiplier" value={`${(navVirtualMul * 100).toFixed(2)}x`} accent="text-white" />
      </Block>

      {/* BC Virtual + Graduation Tiers */}
      <Block title="BC Virtual / Graduation Tiers">
        <Row
          label="Current"
          value={`vBase ${formatNum(vBase / 1e6)} / vTokens ${formatNum(vTokens / 1e6)}`}
          accent="text-white"
        />
        <div className="mt-2 grid grid-cols-5 gap-1 text-[9px] text-gray-500 border-b border-border pb-1 font-bold">
          <span>Tier</span>
          <span className="text-right">Threshold</span>
          <span className="text-right">BC</span>
          <span className="text-right">NAV Mul</span>
          <span className="text-right">Sq²</span>
        </div>
        {DEFAULT_TIERS.map((t, i) => (
          <div key={i} className="grid grid-cols-5 gap-1 text-[9px] py-0.5">
            <span className="text-gray-300">{t.label}</span>
            <span className="text-right text-gray-400">${formatNum(t.threshold)}</span>
            <span className="text-right text-gray-400">{formatNum(t.bcVirtual)}</span>
            <span className="text-right text-gray-400">{t.navMinMul}-{t.navMaxMul}x</span>
            <span className="text-right text-gray-400">{(t.sqBps / 100).toFixed(0)}%</span>
          </div>
        ))}
      </Block>

      {/* Trading Fees */}
      <Block title="Trading Fees">
        <Row
          label="Trading"
          value={`${(tradingFeeBps / 100).toFixed(0)}%`}
          accent="text-amber-300"
          inline
        />
        <Row
          label="Performance"
          value={`${(performanceFeeBps / 100).toFixed(0)}%`}
          accent="text-purple-400"
          inline
        />
      </Block>

      {/* Price Limits */}
      <Block title="Price Limits">
        <Row
          label="Premium"
          value={`${(maxPremiumBps / 100).toFixed(0)}% (${(1 + maxPremiumBps / 10000).toFixed(1)}x)`}
          accent="text-green-400"
        />
        <Row
          label="Discount"
          value={`${(maxDiscountBps / 100).toFixed(0)}% (${(1 - maxDiscountBps / 10000).toFixed(1)}x)`}
          accent="text-red-400"
        />
      </Block>

      {/* Exit Fees */}
      <Block title="Exit Fees">
        <div className="grid grid-cols-4 gap-1 text-[9px]">
          {DEFAULT_EXIT_TIERS.map((t, i) => (
            <div key={i} className="bg-black/40 border border-white/5 p-1.5 text-center">
              <div className="text-gray-500 uppercase">{t.range}</div>
              <div className="text-yellow-400 font-bold">{(t.feeBps / 100).toFixed(0)}%</div>
            </div>
          ))}
        </div>
      </Block>

      {/* Performance */}
      <Block title="Performance">
        <Row label="NAV"          value={`$${summary.lastPrice.toFixed(4)}`}                    accent="text-white" />
        <Row label="Assets"       value={`$${formatNum(summary.tokenSupply * summary.lastPrice)}`} accent="text-cyan-300" />
        <Row label="Holders"      value={summary.uniqueHolders.toString()}                       accent="text-white" />
        <Row label="Net Flow"     value={`${summary.netFlow >= 0 ? '+' : ''}$${formatNum(summary.netFlow)}`} accent={summary.netFlow >= 0 ? 'text-green-400' : 'text-red-400'} />
        <Row label="APY"          value={`${perf.apy.toFixed(1)}%`}                             accent={perf.apy >= 0 ? 'text-green-400' : 'text-red-400'} />
        <Row label="Win Rate"     value={`${(perf.winRate * 100).toFixed(1)}%`}                 accent="text-white" />
        <Row label="Sharpe"       value={perf.sharpe.toFixed(2)}                                 accent="text-white" />
        <Row label="Profit Factor" value={perf.profitFactor === Infinity ? '∞' : perf.profitFactor.toFixed(2)} accent="text-white" />
        <Row label="Max DD"       value={`-${perf.maxDrawdown.toFixed(1)}%`}                    accent="text-red-400" />
        <Row label="Fees"         value={`$${formatNum(fees)}`}                                  accent="text-amber-300" />
        <Row label="Net PnL"      value={`${perf.netPnl >= 0 ? '+' : '-'}$${Math.abs(perf.netPnl).toFixed(2)}`} accent={perf.netPnl >= 0 ? 'text-green-400' : 'text-red-400'} bold />
      </Block>

      {/* Download button */}
      <button
        onClick={onDownload}
        className="w-full py-3 bg-primary text-black font-black uppercase tracking-widest text-xs hover:brightness-110 transition-all flex items-center justify-center gap-2"
      >
        <Download size={14} />
        Download Report JSON
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Mini chart (left column)
// ────────────────────────────────────────────────────────────────────────────
function MiniChart({
  title,
  data,
  color,
  range,
}: {
  title: string;
  data: { time: number; value: number }[];
  color: string;
  range: ChartRange;
}) {
  const filtered = useMemo(() => {
    if (data.length === 0) return [];
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - rangeSecs(range);
    return data.filter((p) => p.time >= cutoff);
  }, [data, range]);

  return (
    <div className="border-t border-border">
      <div className="px-2 py-1 text-[9px] uppercase tracking-widest text-gray-500 font-bold">
        {title}
      </div>
      <div className="h-20">
        {filtered.length < 2 ? (
          <div className="h-full flex items-center justify-center text-[9px] text-gray-600">
            no data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={filtered}>
              <XAxis dataKey="time" hide />
              <YAxis hide domain={['dataMin', 'dataMax']} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0a0a0a',
                  border: '1px solid rgba(42, 46, 57, 0.8)',
                  fontSize: 10,
                  fontFamily: 'monospace',
                  padding: '4px 8px',
                }}
                labelFormatter={(t) => new Date((t as number) * 1000).toLocaleString()}
                formatter={(v) => [Number(v ?? 0).toFixed(4), title]}
              />
              <Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function rangeSecs(r: ChartRange): number {
  if (r === '7D')  return 7 * 86400;
  if (r === '30D') return 30 * 86400;
  if (r === '90D') return 90 * 86400;
  return 365 * 86400;
}

// ────────────────────────────────────────────────────────────────────────────
// Simulation stub (placeholder)
// ────────────────────────────────────────────────────────────────────────────
function SimulationStub() {
  return (
    <div className="p-8 text-center">
      <div className="text-[11px] font-black uppercase tracking-widest text-gray-500 mb-2">
        Simulation Mode
      </div>
      <p className="text-xs text-gray-400 max-w-md mx-auto">
        What-if scenario simulator goes here. Wire to an Anchor program-side
        replay (or a JS port of the BC math) to step through buy/sell
        operations and visualise NAV / supply / price evolution.
      </p>
      <p className="text-[10px] text-gray-600 mt-4 font-mono">
        TODO(solana): port HyperVapor SimulationPanel.tsx scenario engine
      </p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Tiny presentational helpers
// ────────────────────────────────────────────────────────────────────────────
function TopStat({
  label,
  value,
  sub,
  accent,
  muted,
}: { label: string; value: string; sub: string; accent: string; muted?: boolean }) {
  return (
    <div className={`bg-black/60 px-3 py-2 ${muted ? 'opacity-50' : ''}`}>
      <div className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">
        {label}
      </div>
      <div className={`font-mono text-base font-bold ${accent}`}>{value}</div>
      <div className="text-[9px] font-mono text-gray-400">{sub}</div>
    </div>
  );
}

function ModeBtn({
  active,
  onClick,
  label,
}: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-colors ${
        active ? 'bg-primary text-black' : 'text-gray-500 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

function Cell({
  label,
  value,
  accent,
}: { label: string; value: string; accent: string }) {
  return (
    <div className="border-b border-r border-border p-2">
      <div className="text-[9px] text-gray-500 uppercase tracking-widest">{label}</div>
      <div className={`font-mono font-bold ${accent}`}>{value}</div>
    </div>
  );
}

function Block({
  title,
  children,
}: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border p-3">
      <div className="text-[10px] uppercase tracking-widest text-gray-500 font-bold mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  accent,
  inline,
  bold,
}: { label: string; value: string; accent: string; inline?: boolean; bold?: boolean }) {
  if (inline) {
    return (
      <span className="inline-flex items-center gap-1 mr-2">
        <span className="text-gray-500">{label}:</span>
        <span className={`font-bold ${accent}`}>{value}</span>
      </span>
    );
  }
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-gray-500">{label}</span>
      <span className={`font-mono ${accent} ${bold ? 'font-bold' : ''}`}>{value}</span>
    </div>
  );
}

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function formatNum(n: number): string {
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (Math.abs(n) >= 1) return n.toFixed(2);
  if (n === 0) return '0';
  return n.toFixed(4);
}
