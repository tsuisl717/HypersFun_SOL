'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { ShieldCheck, Copy, ArrowLeft, Check } from 'lucide-react';
import type { VaultInfo } from '@/lib/vaults';

const shorten = (s: string, head = 4, tail = 4) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

export default function HeroBar({
  vault,
  holders,
  totalSupply,
}: {
  vault: VaultInfo;
  holders: number | null;
  totalSupply: string | null;
}) {
  const [imgErr, setImgErr] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (val: string, key: string) => {
    navigator.clipboard.writeText(val).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  };

  return (
    <div className="border border-border bg-surface flex items-stretch gap-0">
      {/* Back */}
      <Link
        href="/"
        aria-label="Back to vaults"
        className="flex items-center justify-center px-3 border-r border-border hover:bg-primary/10 hover:text-primary text-gray-500 transition-colors"
      >
        <ArrowLeft size={16} />
      </Link>

      {/* Image */}
      <div className="relative w-20 h-20 sm:w-24 sm:h-24 bg-black border-r border-border shrink-0">
        {vault.imageUrl && !imgErr ? (
          vault.imageUrl.startsWith('data:') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={vault.imageUrl}
              alt={vault.name}
              className="w-full h-full object-cover"
              onError={() => setImgErr(true)}
            />
          ) : (
            <Image
              src={vault.imageUrl}
              alt={vault.name}
              fill
              sizes="96px"
              className="object-cover"
              onError={() => setImgErr(true)}
              unoptimized={!vault.imageUrl.includes('mypinata.cloud')}
            />
          )
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5">
            <span className="text-2xl font-black text-primary/60 italic">
              {vault.symbol?.slice(0, 3) || '?'}
            </span>
          </div>
        )}
      </div>

      {/* Identity */}
      <div className="flex-1 min-w-0 px-4 py-3 flex flex-col justify-center gap-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl sm:text-2xl font-black italic text-white truncate">
            {vault.name || '(no name)'}
          </h1>
          {vault.verified && <ShieldCheck size={16} className="text-primary shrink-0" />}
          <span className="px-2 py-0.5 border border-primary/40 bg-primary/10 text-[10px] font-mono font-bold text-primary uppercase tracking-widest">
            ${vault.symbol}
          </span>
          <span className="px-2 py-0.5 border border-amber-400/40 bg-amber-400/10 text-[10px] font-mono font-bold text-amber-300 uppercase tracking-widest">
            Fee {(vault.performanceFeeBps / 100).toFixed(2)}%
          </span>
        </div>

        <div className="flex items-center gap-4 flex-wrap text-[10px] font-mono text-gray-500 uppercase tracking-widest">
          <AddrChip
            label="Vault"
            value={vault.core}
            copied={copied === 'core'}
            onCopy={() => copy(vault.core, 'core')}
          />
          <AddrChip
            label="Leader"
            value={vault.leader}
            copied={copied === 'leader'}
            onCopy={() => copy(vault.leader, 'leader')}
          />
        </div>
      </div>

      {/* Stats — desktop only */}
      <div className="hidden lg:flex border-l border-border">
        <Stat label="MCAP"    value={formatMoney(parseFloat(vault.tvl))}     accent="text-white" />
        <Stat label="Assets"  value={formatMoney(parseFloat(vault.tvl))}     accent="text-cyan-300" />
        <Stat label="Supply"  value={totalSupply ?? '—'}                      accent="text-white" />
        <Stat label="Buy"     value={`$${parseFloat(vault.buyPrice).toFixed(4)}`} accent="text-lime-400" />
        <Stat label="Sell"    value={`$${parseFloat(vault.buyPrice).toFixed(4)}`} accent="text-rose-400" />
        <Stat label="NAV"     value={`$${parseFloat(vault.nav).toFixed(4)}`}  accent="text-primary" last />
      </div>
    </div>
  );
}

function Stat({
  label, value, accent, last,
}: { label: string; value: string; accent: string; last?: boolean }) {
  return (
    <div className={`px-4 py-3 flex flex-col justify-center min-w-[88px] ${last ? '' : 'border-r border-border'}`}>
      <div className="text-[9px] font-mono text-gray-500 uppercase tracking-widest mb-0.5">{label}</div>
      <div className={`font-mono text-sm font-bold ${accent}`}>{value}</div>
    </div>
  );
}

function AddrChip({
  label, value, copied, onCopy,
}: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <button
      onClick={onCopy}
      className="flex items-center gap-1.5 hover:text-primary transition-colors"
      title="Copy"
    >
      <span>{label}:</span>
      <span className="text-gray-300">{shorten(value, 6, 4)}</span>
      {copied ? <Check size={11} className="text-lime-400" /> : <Copy size={11} />}
    </button>
  );
}

function formatMoney(n: number): string {
  if (!isFinite(n)) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}
