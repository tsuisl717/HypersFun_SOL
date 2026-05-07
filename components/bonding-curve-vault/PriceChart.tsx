'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  IChartApi,
  ColorType,
  CrosshairMode,
  AreaSeries,
} from 'lightweight-charts';

interface PriceChartProps {
  tokenSymbol: string;
  // Future: pass actual price history data
}

export default function PriceChart({ tokenSymbol }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || chartRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 350,
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
      timeScale: { borderColor: 'rgba(42, 46, 57, 0.5)', timeVisible: true },
    });

    const series = chart.addSeries(AreaSeries, {
      topColor: 'rgba(0, 212, 170, 0.4)',
      bottomColor: 'rgba(0, 212, 170, 0.0)',
      lineColor: '#00d4aa',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
    });

    // Placeholder seed data — replace with real vault price history
    const now = Math.floor(Date.now() / 1000);
    series.setData([
      { time: (now - 3600 * 24) as any, value: 1.0 },
      { time: (now - 3600 * 20) as any, value: 1.02 },
      { time: (now - 3600 * 16) as any, value: 0.99 },
      { time: (now - 3600 * 12) as any, value: 1.05 },
      { time: (now - 3600 * 8) as any, value: 1.08 },
      { time: (now - 3600 * 4) as any, value: 1.04 },
      { time: now as any, value: 1.06 },
    ]);

    chart.timeScale().fitContent();
    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight || 350,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  return (
    <div className="h-full bg-[#131722] flex flex-col">
      <div className="px-3 py-2 border-b border-gray-700/50 flex items-center gap-2">
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--primary)]">
          {tokenSymbol}/USDC
        </span>
        <span className="text-[10px] text-gray-600">NAV price history</span>
      </div>
      <div ref={containerRef} className="flex-1" />
    </div>
  );
}
