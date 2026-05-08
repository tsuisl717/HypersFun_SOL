'use client';

/**
 * PositionsChartPanel — sidebar shown next to AdvancedChart on the
 * trading tab when the vault has at least one open Drift margin
 * position. Each position gets its own mini candle chart with entry +
 * liq lines drawn on it (PositionMiniChart).
 *
 * Hidden on screens narrower than `lg` to keep mobile uncluttered —
 * positions are still listed in the Drift activity tab below.
 */

import dynamic from 'next/dynamic';
import { X } from 'lucide-react';
import { useState } from 'react';
import type { ReportOpenPosition } from '@/lib/vault-data-cache';

const PositionMiniChart = dynamic(() => import('./PositionMiniChart'), {
  ssr: false,
});

interface Props {
  positions: ReportOpenPosition[];
}

export default function PositionsChartPanel({ positions }: Props) {
  const [hidden, setHidden] = useState(false);
  if (positions.length === 0 || hidden) return null;

  return (
    <div className="bg-card flex flex-col h-full overflow-hidden border-r border-border">
      {/* Sticky header — match HyperVapor's "L1 PERP (n)" style */}
      <div className="px-2 py-1.5 border-b border-border flex items-center gap-2 shrink-0 bg-card">
        <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">
          L1 Perp ({positions.length})
        </span>
        <button
          onClick={() => setHidden(true)}
          className="ml-auto text-gray-500 hover:text-white cursor-pointer p-0.5"
          title="Hide panel"
        >
          <X size={12} />
        </button>
      </div>

      {/* Scrollable stack of mini charts — each takes equal share of height */}
      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
        {positions.map((p) => (
          <PositionMiniChart key={p.pda} position={p} />
        ))}
      </div>
    </div>
  );
}
