'use client';

/**
 * DriftChart — candlestick chart for a Drift perp market.
 *
 * Data source: GET https://data.api.drift.trade/market/{symbol}/candles/{resolution}
 * Devnet has no Data API → shows a placeholder.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CrosshairMode,
  ColorType,
  CandlestickSeries,
} from 'lightweight-charts';
import { Loader2, RefreshCw, TrendingUp } from 'lucide-react';

import { fetchDriftCandles, type DriftResolution } from '@/lib/drift/api';
import type { OHLCV } from '@/lib/indicators';
import { NETWORK } from '@/lib/contracts/config';

interface Props {
  symbol: string;
  height?: number;
}

const RESOLUTIONS: { value: DriftResolution; label: string }[] = [
  { value: '15',  label: '15M' },
  { value: '60',  label: '1H'  },
  { value: '240', label: '4H'  },
  { value: 'D',   label: '1D'  },
];

export default function DriftChart({ symbol, height = 280 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  const [resolution, setResolution] = useState<DriftResolution>('60');
  const [candles, setCandles] = useState<OHLCV[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const isDevnet = NETWORK === 'devnet';

  // ─── Load candles ─────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDriftCandles(symbol, resolution, 300);
      setCandles(data);
      if (data.length === 0 && !isDevnet) {
        setError('No candles returned.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 140) : 'load failed');
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [symbol, resolution, isDevnet]);

  useEffect(() => { load(); }, [load]);

  // ─── Chart lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    if (!chartRef.current) {
      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || height,
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
      seriesRef.current = chart.addSeries(CandlestickSeries, {
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderUpColor: '#26a69a',
        borderDownColor: '#ef5350',
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
      });

      const ro = new ResizeObserver(() => {
        if (containerRef.current && chartRef.current) {
          chartRef.current.applyOptions({
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight || height,
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
    }
  }, [candles.length, height]);

  // ─── Push data into series ────────────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;
    seriesRef.current.setData(
      candles.map(c => ({
        time: c.time as never,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // ─── Stats ───────────────────────────────────────────────────────────
  const lastPrice = candles[candles.length - 1]?.close ?? 0;
  const firstPrice = candles[0]?.open ?? 0;
  const change = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;

  return (
    <div className="flex flex-col bg-[#131722] flex-1 min-h-0 relative">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card">
        <span className="text-[11px] font-mono font-bold text-white">{symbol}</span>
        {lastPrice > 0 && (
          <>
            <span className="text-[11px] font-mono text-white">
              ${lastPrice.toFixed(lastPrice < 1 ? 6 : 2)}
            </span>
            <span
              className={`text-[10px] font-mono font-bold ${
                change >= 0 ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {change >= 0 ? '+' : ''}{change.toFixed(2)}%
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {RESOLUTIONS.map(r => (
            <button
              key={r.value}
              onClick={() => setResolution(r.value)}
              className={`px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest border transition-colors ${
                resolution === r.value
                  ? 'bg-purple-500/20 border-purple-400/50 text-purple-300'
                  : 'border-transparent text-gray-500 hover:text-white'
              }`}
            >
              {r.label}
            </button>
          ))}
          <button
            onClick={load}
            disabled={loading}
            className="ml-1 p-1 text-gray-500 hover:text-purple-400 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Chart body */}
      <div className="flex-1 relative" style={{ minHeight: height }}>
        <div ref={containerRef} className="absolute inset-0" />

        {/* Loading overlay */}
        {loading && candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {/* Empty / devnet placeholder */}
        {!loading && candles.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
            <TrendingUp size={32} className="text-purple-400/40 mb-2" />
            <div className="text-sm text-white font-mono font-bold mb-1">
              No chart data
            </div>
            <div className="text-[11px] text-gray-500 font-mono leading-relaxed max-w-xs">
              {isDevnet
                ? 'Drift devnet (vELoC1) does not publish candle history. Switch to mainnet to see live charts.'
                : error ?? `Drift Data API returned no candles for ${symbol}.`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
