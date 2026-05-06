'use client';

import type { VaultInfo } from '@/lib/vaults';

export default function StatsGrid({
  vault,
  holders,
  totalSupply,
}: {
  vault: VaultInfo;
  holders: number | null;
  totalSupply: string | null;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-border">
      <Stat label="NAV"     value={`$${parseFloat(vault.nav).toFixed(4)}`}        accent="text-lime-400" />
      <Stat label="Buy"     value={`$${parseFloat(vault.buyPrice).toFixed(4)}`}    accent="text-white" />
      <Stat label="TVL"     value={`$${parseFloat(vault.tvl).toFixed(2)}`}         accent="text-primary" />
      <Stat label="Volume"  value={`$${parseFloat(vault.totalVolume).toFixed(2)}`} accent="text-amber-300" />
      <Stat label="Supply"  value={totalSupply ?? '—'}                              accent="text-cyan-300" />
      <Stat label="Holders" value={holders === null ? '—' : holders.toString()}     accent="text-fuchsia-300" />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="bg-black/60 p-4 text-center">
      <div className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">{label}</div>
      <div className={`text-lg font-mono font-bold ${accent}`}>{value}</div>
    </div>
  );
}
