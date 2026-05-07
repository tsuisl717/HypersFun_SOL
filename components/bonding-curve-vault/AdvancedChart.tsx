'use client';

/**
 * AdvancedChart — candlestick / line / area price chart with technical
 * indicator overlays (MA7, MA25, EMA12, EMA26, Bollinger Bands).
 *
 * Data source: real Buy/Sell events read from the Solana RPC by parsing
 * Anchor program logs. Trades are cached in localStorage and synced
 * incrementally so repeat visits only fetch new transactions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  Time,
  CrosshairMode,
  ColorType,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
} from 'lightweight-charts';
import { Loader2, RefreshCw } from 'lucide-react';

import { getProgram } from '@/lib/contracts/margin';
import {
  loadVaultTrades,
  buildCandlesFromTrades,
  type VaultTrade,
} from '@/lib/vault-events';
import {
  calculateSMA,
  calculateEMA,
  calculateBollingerBands,
  type OHLCV,
} from '@/lib/indicators';

// ─── Types ──────────────────────────────────────────────────────────────────
type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
type ChartKind = 'candle' | 'line' | 'area';

interface AdvancedChartProps {
  vaultAddress: string;
  tokenSymbol?: string;
  currentPrice?: number;       // current spot price (USDC) — used for live last-candle update
}

// ─── Constants ──────────────────────────────────────────────────────────────
const INTERVAL_OPTIONS: { value: Interval; label: string; secs: number }[] = [
  { value: '1m',  label: '1M',  secs: 60      },
  { value: '5m',  label: '5M',  secs: 300     },
  { value: '15m', label: '15M', secs: 900     },
  { value: '1h',  label: '1H',  secs: 3600    },
  { value: '4h',  label: '4H',  secs: 14400   },
  { value: '1d',  label: '1D',  secs: 86400   },
];

const INDICATORS = [
  { key: 'ma7',   label: 'MA7',   color: '#f59e0b' },
  { key: 'ma25',  label: 'MA25',  color: '#8b5cf6' },
  { key: 'ema12', label: 'EMA12', color: '#06b6d4' },
  { key: 'ema26', label: 'EMA26', color: '#ec4899' },
  { key: 'bb',    label: 'BB',    color: '#4caf50' },
] as const;
type IndicatorKey = (typeof INDICATORS)[number]['key'];

// ─── Component ──────────────────────────────────────────────────────────────
export default function AdvancedChart({
  vaultAddress,
  tokenSymbol = 'TOKEN',
  currentPrice,
}: AdvancedChartProps) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<
    ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | null
  >(null);
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

  const [interval, setInterval] = useState<Interval>('15m');
  const [chartKind, setChartKind] = useState<ChartKind>('candle');
  const [enabledIndicators, setEnabledIndicators] = useState<Record<IndicatorKey, boolean>>({
    ma7: true,
    ma25: false,
    ema12: false,
    ema26: false,
    bb: false,
  });

  // Trade data state
  const [trades, setTrades] = useState<VaultTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // ─── Read-only Anchor provider (works even without connected wallet) ──
  const getReadProvider = useCallback((): anchor.AnchorProvider => {
    if (publicKey && signTransaction && signAllTransactions) {
      return new anchor.AnchorProvider(
        connection,
        { publicKey, signTransaction, signAllTransactions },
        { commitment: 'confirmed' },
      );
    }
    return new anchor.AnchorProvider(
      connection,
      {
        publicKey: PublicKey.default,
        signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
        signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs,
      },
      { commitment: 'confirmed' },
    );
  }, [connection, publicKey, signTransaction, signAllTransactions]);

  // ─── Load trades (cached + incremental sync) ──────────────────────────
  const syncTrades = useCallback(
    async (forceRefresh = false) => {
      if (!vaultAddress) return;
      setSyncing(true);
      setSyncError(null);
      try {
        const program = getProgram(getReadProvider());
        const fetched = await loadVaultTrades(
          connection,
          program,
          new PublicKey(vaultAddress),
          { signatureLimit: 500, concurrency: 5, forceRefresh },
        );
        setTrades(fetched);
      } catch (e) {
        console.error('[AdvancedChart] sync error:', e);
        setSyncError(e instanceof Error ? e.message.slice(0, 120) : 'sync failed');
      } finally {
        setLoading(false);
        setSyncing(false);
      }
    },
    [vaultAddress, connection, getReadProvider],
  );

  useEffect(() => { syncTrades(false); }, [syncTrades]);

  // ─── Build candle series from real trades ─────────────────────────────
  const candles = useMemo<OHLCV[]>(() => {
    const intervalSecs = INTERVAL_OPTIONS.find((o) => o.value === interval)!.secs;
    const base = buildCandlesFromTrades(trades, intervalSecs);

    // Append a live "current bucket" candle using currentPrice if it's
    // beyond the last trade bucket — gives the chart a moving last candle
    // even between trades.
    if (currentPrice && currentPrice > 0) {
      const now = Math.floor(Date.now() / 1000);
      const liveBucket = Math.floor(now / intervalSecs) * intervalSecs;
      const last = base[base.length - 1];

      if (!last) {
        return [{
          time: liveBucket,
          open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice,
          volume: 0,
        }];
      }
      if (liveBucket > last.time) {
        return [
          ...base,
          {
            time: liveBucket,
            open: last.close,
            high: Math.max(last.close, currentPrice),
            low: Math.min(last.close, currentPrice),
            close: currentPrice,
            volume: 0,
          },
        ];
      }
      // Same bucket as last candle — extend it with the live price
      return [
        ...base.slice(0, -1),
        {
          ...last,
          high: Math.max(last.high, currentPrice),
          low: Math.min(last.low, currentPrice),
          close: currentPrice,
        },
      ];
    }

    return base;
  }, [trades, interval, currentPrice]);

  const lastPrice = candles.length > 0 ? candles[candles.length - 1].close : currentPrice ?? 0;
  const priceChange = useMemo(() => {
    if (candles.length < 2) return 0;
    const first = candles[0].open;
    if (first <= 0) return 0;
    return ((lastPrice - first) / first) * 100;
  }, [candles, lastPrice]);

  // ─── Chart lifecycle: create once ─────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    if (chartRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 400,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#d1d4dc',
      },
      grid: {
        vertLines: { color: 'rgba(42, 46, 57, 0.3)' },
        horzLines: { color: 'rgba(42, 46, 57, 0.3)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(42, 46, 57, 0.5)' },
      timeScale: {
        borderColor: 'rgba(42, 46, 57, 0.5)',
        timeVisible: true,
        secondsVisible: false,
      },
    });
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight || 400,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      indicatorSeriesRef.current.clear();
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
    };
  }, []);

  // ─── (Re-)create main series when chart kind changes ──────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (mainSeriesRef.current) {
      try { chart.removeSeries(mainSeriesRef.current); } catch { /* ignore */ }
      mainSeriesRef.current = null;
    }

    if (chartKind === 'candle') {
      mainSeriesRef.current = chart.addSeries(CandlestickSeries, {
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderUpColor: '#26a69a',
        borderDownColor: '#ef5350',
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
        priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      });
    } else if (chartKind === 'line') {
      mainSeriesRef.current = chart.addSeries(LineSeries, {
        color: '#00d4aa',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      });
    } else {
      mainSeriesRef.current = chart.addSeries(AreaSeries, {
        topColor: 'rgba(0, 212, 170, 0.4)',
        bottomColor: 'rgba(0, 212, 170, 0.0)',
        lineColor: '#00d4aa',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      });
    }
  }, [chartKind]);

  // ─── Push candle data ────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    const series = mainSeriesRef.current;
    if (!chart || !series || candles.length === 0) return;

    if (chartKind === 'candle') {
      (series as ISeriesApi<'Candlestick'>).setData(
        candles.map((c) => ({
          time: c.time as Time,
          open: c.open, high: c.high, low: c.low, close: c.close,
        })),
      );
    } else {
      (series as ISeriesApi<'Line'>).setData(
        candles.map((c) => ({ time: c.time as Time, value: c.close })),
      );
    }

    chart.timeScale().fitContent();
  }, [candles, chartKind]);

  // ─── Indicator overlays ──────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;

    for (const [key, series] of indicatorSeriesRef.current.entries()) {
      try { chart.removeSeries(series); } catch { /* ignore */ }
      indicatorSeriesRef.current.delete(key);
    }

    if (enabledIndicators.ma7 && candles.length >= 7) {
      addLineIndicator(chart, 'ma7', '#f59e0b', calculateSMA(candles, 7));
    }
    if (enabledIndicators.ma25 && candles.length >= 25) {
      addLineIndicator(chart, 'ma25', '#8b5cf6', calculateSMA(candles, 25));
    }
    if (enabledIndicators.ema12 && candles.length >= 12) {
      addLineIndicator(chart, 'ema12', '#06b6d4', calculateEMA(candles, 12));
    }
    if (enabledIndicators.ema26 && candles.length >= 26) {
      addLineIndicator(chart, 'ema26', '#ec4899', calculateEMA(candles, 26));
    }
    if (enabledIndicators.bb && candles.length >= 20) {
      const bb = calculateBollingerBands(candles, 20, 2);
      addLineIndicator(chart, 'bb-upper',  '#4caf50', bb.upper);
      addLineIndicator(chart, 'bb-middle', '#4caf5080', bb.middle);
      addLineIndicator(chart, 'bb-lower',  '#4caf50', bb.lower);
    }

    function addLineIndicator(
      c: IChartApi,
      key: string,
      color: string,
      data: { time: number; value: number }[],
    ) {
      const series = c.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData(data.map((d) => ({ time: d.time as Time, value: d.value })));
      indicatorSeriesRef.current.set(key, series);
    }
  }, [enabledIndicators, candles]);

  const toggleIndicator = (k: IndicatorKey) =>
    setEnabledIndicators((p) => ({ ...p, [k]: !p[k] }));

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col bg-[#131722]">
      {/* Header: pair + price + chart-type + interval */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700/50 gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-bold uppercase tracking-wider text-white shrink-0">
            {tokenSymbol}/USDC
          </span>
          {lastPrice > 0 && (
            <>
              <span className="text-base font-mono font-bold text-white">
                ${lastPrice.toFixed(4)}
              </span>
              <span
                className={`text-[10px] font-mono font-bold px-1.5 py-0.5 border ${
                  priceChange >= 0
                    ? 'text-green-400 bg-green-500/10 border-green-500/30'
                    : 'text-red-400 bg-red-500/10 border-red-500/30'
                }`}
              >
                {priceChange >= 0 ? '+' : ''}
                {priceChange.toFixed(2)}%
              </span>
            </>
          )}
          {syncing && (
            <span className="text-[10px] text-gray-500 flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" /> syncing…
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Manual resync */}
          <button
            onClick={() => syncTrades(false)}
            disabled={syncing}
            className="p-1 text-gray-400 hover:text-primary disabled:opacity-40 cursor-pointer"
            title="Sync new trades"
          >
            <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
          </button>

          {/* Chart type */}
          <div className="flex bg-white/5 overflow-hidden">
            {(['candle', 'line', 'area'] as ChartKind[]).map((t) => (
              <button
                key={t}
                onClick={() => setChartKind(t)}
                className={`px-2 py-1 text-[10px] cursor-pointer transition-colors ${
                  chartKind === t
                    ? 'bg-primary text-black'
                    : 'text-gray-400 hover:text-white'
                }`}
                title={t}
              >
                {t === 'candle' ? '🕯️' : t === 'line' ? '📈' : '📊'}
              </button>
            ))}
          </div>
          {/* Interval */}
          <div className="flex bg-white/5 overflow-hidden">
            {INTERVAL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setInterval(opt.value)}
                className={`px-2 py-1 text-[10px] font-bold uppercase cursor-pointer transition-colors ${
                  interval === opt.value
                    ? 'bg-primary text-black'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Indicator bar */}
      <div className="flex items-center flex-wrap gap-1.5 px-3 py-1.5 border-b border-gray-700/50">
        <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">
          IND:
        </span>
        {INDICATORS.map((ind) => {
          const active = enabledIndicators[ind.key];
          return (
            <button
              key={ind.key}
              onClick={() => toggleIndicator(ind.key)}
              className={`px-2 py-0.5 text-[10px] font-bold border cursor-pointer transition-colors ${
                active ? 'border-transparent text-white' : 'border-gray-600 text-gray-400 hover:text-white'
              }`}
              style={{
                backgroundColor: active ? ind.color : 'transparent',
              }}
            >
              {ind.label}
            </button>
          );
        })}
      </div>

      {/* Chart canvas (with overlay states) */}
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="absolute inset-0" />
        {loading && trades.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#131722]/70 z-10">
            <div className="flex items-center gap-2 text-gray-400 text-xs font-mono">
              <Loader2 size={14} className="animate-spin" />
              Loading trades from chain…
            </div>
          </div>
        )}
        {!loading && trades.length === 0 && !syncError && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-xs font-mono">
            No trades yet on this vault.
          </div>
        )}
        {syncError && (
          <div className="absolute top-2 left-2 right-2 px-2 py-1 bg-red-500/10 border border-red-500/30 text-red-400 text-[10px] font-mono">
            Sync error: {syncError}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1 border-t border-gray-700/50 text-[9px] font-mono text-gray-600 flex items-center justify-between">
        <span>
          {trades.length > 0
            ? `${trades.length} on-chain trade${trades.length === 1 ? '' : 's'} · cached locally`
            : 'No trades — chart will populate once buys/sells occur'}
        </span>
        <span>
          {candles.length} candle{candles.length === 1 ? '' : 's'} · {interval}
        </span>
      </div>
    </div>
  );
}
