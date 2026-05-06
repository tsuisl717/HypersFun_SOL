'use client';

import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineSeries, type IChartApi } from 'lightweight-charts';
import type { VaultInfo } from '@/lib/vaults';

const TIMEFRAMES = ['1M', '5M', '15M', '1H', '4H', '1D'] as const;
const INDICATORS = ['MA7', 'MA25', 'EMA12', 'EMA26', 'BB'] as const;

export default function ChartPanel({ vault }: { vault: VaultInfo }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [tf, setTf] = useState<typeof TIMEFRAMES[number]>('15M');
  const [activeInds, setActiveInds] = useState<string[]>(['MA7']);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#6b7280',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(80, 210, 193, 0.05)' },
        horzLines: { color: 'rgba(80, 210, 193, 0.05)' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(80, 210, 193, 0.15)',
      },
      rightPriceScale: {
        borderColor: 'rgba(80, 210, 193, 0.15)',
      },
      crosshair: { mode: 1 },
    });

    const series = chart.addSeries(LineSeries, {
      color: '#50d2c1',
      lineWidth: 2,
      priceLineVisible: true,
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
    });

    // Seed with the current TWAP NAV as a single point so the chart isn't blank.
    const now = Math.floor(Date.now() / 1000);
    const nav = parseFloat(vault.nav) || 1;
    series.setData([
      { time: (now - 3600) as any, value: nav },
      { time: now as any, value: nav },
    ]);

    chart.timeScale().fitContent();
    chartRef.current = chart;

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [vault.nav, tf]);

  const change = vault.priceChange24h ?? 0;
  const changeColor = change >= 0 ? 'text-lime-400' : 'text-rose-400';
  const changeSign = change >= 0 ? '+' : '';

  return (
    <div className="border border-border bg-surface flex flex-col h-full">
      {/* Top toolbar */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border flex-wrap">
        <div className="flex items-baseline gap-3">
          <div className="text-sm font-mono font-bold text-white uppercase tracking-widest">
            {vault.symbol}/USDC
          </div>
          <div className="text-base font-mono font-bold text-white">
            ${parseFloat(vault.buyPrice).toFixed(4)}
          </div>
          <div className={`text-xs font-mono font-bold ${changeColor}`}>
            {changeSign}{change.toFixed(2)}%
          </div>
        </div>

        <div className="flex items-center gap-1">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={`px-2.5 py-1 text-[10px] font-mono font-bold uppercase tracking-widest transition-colors ${
                tf === t
                  ? 'bg-primary/15 text-primary border border-primary/40'
                  : 'text-gray-500 hover:text-white border border-transparent'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Indicators bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-black/40">
        <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">Ind:</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {INDICATORS.map((ind) => {
            const on = activeInds.includes(ind);
            return (
              <button
                key={ind}
                onClick={() => setActiveInds((prev) =>
                  prev.includes(ind) ? prev.filter((x) => x !== ind) : [...prev, ind])}
                className={`px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-widest transition-colors ${
                  on
                    ? 'bg-amber-400/15 text-amber-300 border border-amber-400/40'
                    : 'text-gray-500 hover:text-white border border-border'
                }`}
              >
                {ind}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest">
          <span className="text-gray-500">L1:</span>
          <span className="px-2 py-0.5 border border-amber-400/40 bg-amber-400/10 text-amber-300 font-bold">
            Assets
          </span>
        </div>
      </div>

      {/* Chart */}
      <div className="relative flex-1 min-h-[320px]">
        <div ref={containerRef} className="absolute inset-0" />
        <div className="absolute top-3 left-3 text-[10px] font-mono text-gray-600 uppercase tracking-widest pointer-events-none">
          ⓘ Price history coming soon — showing current NAV reference line
        </div>
      </div>

      {/* Footer (mimic screenshot's L1 indicator strip) */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-border text-[10px] font-mono text-gray-500 uppercase tracking-widest">
        <span>L1: $1</span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" />
          Live
        </span>
      </div>
    </div>
  );
}
