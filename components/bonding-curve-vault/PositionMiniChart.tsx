'use client';

/**
 * PositionMiniChart — compact candlestick chart for a single open Drift
 * margin position. Renders entry + liq price lines on top of the candles
 * so the leader can eyeball the live PnL and proximity to liquidation
 * without leaving the trading tab.
 *
 * Data source: shared `fetchDriftCandles` (Drift API on mainnet, Binance
 * Futures fallback on devnet — see lib/drift/api.ts).
 *
 * Liquidation is approximated as `entry * (1 ± 1/leverage)` (zero
 * maintenance margin), which is conservative — the real liq price is
 * tighter because Drift charges maintenance margin (~5% per market).
 * Surfacing the rough number is good enough for "are we close?" eyeball
 * checks; precise liq calc would require pulling the PerpMarket account.
 */

import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CrosshairMode,
  ColorType,
  CandlestickSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';

import {
  fetchDriftCandles,
  getMarketSymbol,
  type DriftResolution,
  type CandlesSource,
} from '@/lib/drift/api';
import type { OHLCV } from '@/lib/indicators';
import type { ReportOpenPosition } from '@/lib/vault-data-cache';

const RESOLUTIONS: { v: DriftResolution; l: string }[] = [
  { v: '15',  l: '15M' },
  { v: '60',  l: '1H'  },
  { v: '240', l: '4H'  },
  { v: 'D',   l: '1D'  },
];

interface Props {
  position: ReportOpenPosition;
}

export default function PositionMiniChart({ position }: Props) {
  const sym = getMarketSymbol(position.marketIndex);

  const [interval, setInterval] = useState<DriftResolution>('60');
  const [candles, setCandles] = useState<OHLCV[]>([]);
  const [source, setSource] = useState<CandlesSource>('none');
  const [loading, setLoading] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  // Derived: rough liquidation + live PnL.
  const notional = position.baseAmount * position.entryPrice;
  const leverage = position.usdcCollateral > 0 ? notional / position.usdcCollateral : 0;
  const liqDist = leverage > 0 ? 1 / leverage : 0;
  const liq = position.direction === 'long'
    ? position.entryPrice * (1 - liqDist)
    : position.entryPrice * (1 + liqDist);

  const livePrice = candles.length > 0 ? candles[candles.length - 1].close : 0;
  const pnl = livePrice > 0 && position.entryPrice > 0
    ? (livePrice - position.entryPrice) *
      position.baseAmount *
      (position.direction === 'long' ? 1 : -1)
    : 0;

  // ─── Fetch candles ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchDriftCandles(sym, interval, 200)
      .then((r) => {
        if (cancelled) return;
        setCandles(r.candles);
        setSource(r.source);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sym, interval]);

  // ─── Create chart once ────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || chartRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 200,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#9ca3af',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(42, 46, 57, 0.2)' },
        horzLines: { color: 'rgba(42, 46, 57, 0.2)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: 'rgba(42, 46, 57, 0.5)',
        scaleMargins: { top: 0.1, bottom: 0.15 },
      },
      timeScale: {
        borderColor: 'rgba(42, 46, 57, 0.5)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
      },
    });
    chartRef.current = chart;

    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      priceFormat: {
        type: 'price',
        precision: position.entryPrice < 1 ? 6 : 2,
        minMove: position.entryPrice < 1 ? 0.000001 : 0.01,
      },
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight || 200,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Push candle data ──────────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || candles.length === 0) return;
    series.setData(
      candles.map((c) => ({
        time: c.time as never,
        open: c.open, high: c.high, low: c.low, close: c.close,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // ─── Entry + Liq price lines ───────────────────────────────────────────
  // Recreated whenever the underlying values change (interval switch, new
  // position data). lightweight-charts has no enumeration API, so we
  // capture the IPriceLine refs and remove them on cleanup.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || candles.length === 0) return;

    const entryColor = position.direction === 'long' ? '#26a69a' : '#ef5350';
    const entryLine = series.createPriceLine({
      price: position.entryPrice,
      color: entryColor,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Entry',
    });
    const liqLine = series.createPriceLine({
      price: liq,
      color: '#f97316',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Liq',
    });

    return () => {
      try { series.removePriceLine(entryLine); } catch { /* chart torn down */ }
      try { series.removePriceLine(liqLine);   } catch { /* chart torn down */ }
    };
  }, [position.entryPrice, position.direction, liq, candles.length]);

  // ─── Render ────────────────────────────────────────────────────────────
  const sideShort = position.direction === 'long' ? 'L' : 'S';
  const sideColor = position.direction === 'long' ? 'text-primary' : 'text-red-400';
  const pnlColor = pnl >= 0 ? 'text-green-400' : 'text-red-400';

  return (
    <div className="flex flex-col bg-[#131722] border-b border-border last:border-b-0 min-h-0 flex-1">
      {/* Header — symbol, side, live PnL, interval picker */}
      <div className="px-2 py-1 border-b border-border flex items-center gap-1.5 text-[10px] font-mono shrink-0">
        <span className={`font-black uppercase tracking-wider ${sideColor}`}>
          {sym} {sideShort}
        </span>
        <span className={`font-bold ${pnlColor}`}>
          {pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toFixed(2)}
        </span>
        <div className="ml-auto flex">
          {RESOLUTIONS.map((r) => (
            <button
              key={r.v}
              onClick={() => setInterval(r.v)}
              className={`px-1.5 py-0.5 text-[9px] uppercase tracking-widest cursor-pointer ${
                interval === r.v
                  ? 'bg-primary/20 text-primary border-b border-primary'
                  : 'text-gray-500 hover:text-white'
              }`}
            >
              {r.l}
            </button>
          ))}
        </div>
      </div>

      {/* Sub-header — entry + liq numbers */}
      <div className="px-2 py-0.5 border-b border-border text-[9px] font-mono text-gray-400 flex flex-wrap gap-x-3 shrink-0">
        <span>
          Entry:{' '}
          <span className="text-white">${formatPrice(position.entryPrice)}</span>
        </span>
        <span>
          Liq:{' '}
          <span className="text-orange-400">${formatPrice(liq)}</span>
        </span>
        {leverage > 0 && (
          <span className="text-gray-500">
            {leverage.toFixed(1)}x
          </span>
        )}
      </div>

      {/* Chart canvas */}
      <div className="flex-1 relative min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
        {loading && candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-[10px] font-mono">
            loading…
          </div>
        )}
        {!loading && candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-center px-4">
            <span className="text-[10px] text-gray-500 font-mono">
              No chart data for {sym}
            </span>
          </div>
        )}
        {/* Source tag */}
        {source !== 'none' && candles.length > 0 && (
          <span
            className={`absolute top-1 left-1 text-[8px] font-mono font-bold uppercase tracking-widest px-1 py-0.5 border ${
              source === 'drift'
                ? 'text-purple-300 border-purple-400/40 bg-purple-500/10'
                : 'text-yellow-300 border-yellow-400/40 bg-yellow-500/10'
            }`}
          >
            {source}
          </span>
        )}
      </div>
    </div>
  );
}

function formatPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return '0';
  if (p < 1) return p.toFixed(6);
  if (p < 100) return p.toFixed(4);
  return p.toFixed(2);
}
