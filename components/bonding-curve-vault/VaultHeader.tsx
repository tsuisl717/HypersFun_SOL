'use client';

/**
 * VaultHeader — top header strip with image, name, $symbol, fee, contract /
 * leader addresses, and a stats grid (MCap / Assets / Supply / Buy / Sell /
 * NAV).
 *
 * Solana port of HyperVapor-Fun/components/bonding-curve-vault/VaultHeader.tsx.
 * UI structure preserved 1:1; data slots accept `null` so the consumer can
 * pass empty placeholders while wiring contract data.
 */

import { useRouter } from 'next/navigation';
import { ArrowLeft, Copy } from 'lucide-react';
import { useState, useEffect } from 'react';
import Image from 'next/image';

import type { VaultInfo, ReserveStatus } from './types';

interface CurrentTierInfo {
  label: string;
  multiplier: number;
}

export interface VaultHeaderProps {
  vaultInfo: VaultInfo | null;
  vaultAddress: string;
  isLeader: boolean;
  isLoading?: boolean;
  /** Total assets in human USDC. Pass `undefined` while loading. */
  totalAssets?: number;
  reserveStatus?: ReserveStatus | null;
  currentTier?: CurrentTierInfo | null;
  onVaultAddressChange: (address: string) => void;
  onLoadVault: () => void;
}

export default function VaultHeader({
  vaultInfo,
  vaultAddress,
  isLeader,
  isLoading = false,
  totalAssets,
  // reserveStatus reserved for future "Low Liq" badge — wire when ready
  reserveStatus: _reserveStatus,
  currentTier,
  onVaultAddressChange,
  onLoadVault,
}: VaultHeaderProps) {
  const router = useRouter();
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setImageError(false);
  }, [vaultInfo?.imageUrl]);

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedAddress(label);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  // Loaded — full header
  if (vaultInfo) {
    return (
      <div className="bg-card border-b border-border">
        {/* Mobile compact */}
        <div className="md:hidden px-2 py-1.5">
          <div className="flex items-center gap-2 mb-1">
            <button
              onClick={() => router.push('/')}
              className="w-6 h-6 flex cursor-pointer items-center justify-center border border-border hover:bg-white/5 text-gray-500 hover:text-white shrink-0"
            >
              <ArrowLeft size={12} />
            </button>
            <div className="w-7 h-7 border border-border bg-black relative shrink-0 overflow-hidden">
              {vaultInfo.imageUrl && !imageError ? (
                vaultInfo.imageUrl.startsWith('data:') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={vaultInfo.imageUrl}
                    alt={vaultInfo.name}
                    className="w-full h-full object-cover"
                    onError={() => setImageError(true)}
                  />
                ) : (
                  <Image
                    src={vaultInfo.imageUrl}
                    alt={vaultInfo.name}
                    fill
                    sizes="28px"
                    className="object-cover"
                    onError={() => setImageError(true)}
                    unoptimized
                  />
                )
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs font-bold text-gray-500">
                  {vaultInfo.symbol?.slice(0, 2) || '??'}
                </div>
              )}
            </div>
            <span className="text-sm font-black uppercase italic text-white tracking-tighter truncate">
              {vaultInfo.name}
            </span>
            <span className="text-[9px] font-mono font-bold text-primary bg-primary/10 px-2 py-1 border border-primary/20 shrink-0 h-5 flex items-center">
              ${vaultInfo.symbol}
            </span>
            {isLeader && (
              <span className="text-[9px] font-bold text-green-400 bg-green-400/10 px-2 py-1 border border-green-400/20 shrink-0 h-5 flex items-center">
                Leader
              </span>
            )}
            {currentTier && (
              <span className="text-[9px] font-bold text-yellow-400 bg-yellow-400/10 px-2 py-1 border border-yellow-400/20 shrink-0 h-5 flex items-center">
                {currentTier.label} {currentTier.multiplier.toFixed(2)}x
              </span>
            )}
          </div>

          {/* Stats grid — mobile */}
          <div className="text-[9px] font-mono space-y-0.5">
            <div className="grid grid-cols-4 text-gray-400">
              <span className="text-center">
                MC<br />
                <span className="text-white font-bold">
                  ${(parseFloat(vaultInfo.buyPrice || '0') * parseFloat(vaultInfo.totalSupply || '0')).toFixed(0)}
                </span>
              </span>
              <span className="text-center">
                Buy<br />
                <span className="text-primary font-bold">${parseFloat(vaultInfo.buyPrice || '0').toFixed(4)}</span>
              </span>
              <span className="text-center">
                Sell<br />
                <span className="text-red-400 font-bold">${parseFloat(vaultInfo.sellPrice || '0').toFixed(4)}</span>
              </span>
              <span className="text-center">
                NAV<br />
                <span className="text-white font-bold">${parseFloat(vaultInfo.nav || '0').toFixed(4)}</span>
              </span>
            </div>

            <div className="grid grid-cols-3 text-gray-400 border-t border-border/50 pt-0.5">
              <button onClick={() => copyToClipboard(vaultInfo.address, 'contract')} className="text-center hover:text-white">
                CA<br />
                <span className="text-primary">
                  {vaultInfo.address.slice(0, 6)}..{vaultInfo.address.slice(-4)}
                </span>
                {copiedAddress === 'contract' && <span className="text-green-400 ml-0.5">✓</span>}
              </button>
              <button onClick={() => copyToClipboard(vaultInfo.leader, 'leader')} className="text-center hover:text-white">
                Lead<br />
                <span className="text-primary">
                  {vaultInfo.leader.slice(0, 6)}..{vaultInfo.leader.slice(-4)}
                </span>
                {copiedAddress === 'leader' && <span className="text-green-400 ml-0.5">✓</span>}
              </button>
              <span className="text-center text-blue-400 font-bold">
                Fee<br />
                {(parseInt(vaultInfo.feeBps || '0') / 100).toFixed(1)}%
              </span>
            </div>
          </div>
        </div>

        {/* Desktop wide */}
        <div className="hidden md:flex py-4 px-6 items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <button
              onClick={() => router.push('/')}
              className="w-10 h-10 flex cursor-pointer items-center justify-center border border-border hover:bg-white/5 transition-all text-gray-500 hover:text-white shrink-0"
            >
              <ArrowLeft size={20} />
            </button>
            <div className="w-20 h-20 border border-border bg-black shadow-2xl relative shrink-0 overflow-hidden">
              {vaultInfo.imageUrl && !imageError ? (
                vaultInfo.imageUrl.startsWith('data:') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={vaultInfo.imageUrl}
                    alt={vaultInfo.name}
                    className="w-full h-full object-cover"
                    onError={() => setImageError(true)}
                  />
                ) : (
                  <Image
                    src={vaultInfo.imageUrl}
                    alt={vaultInfo.name}
                    fill
                    sizes="80px"
                    className="object-cover"
                    onError={() => setImageError(true)}
                    unoptimized
                  />
                )
              ) : (
                <div className="w-full h-full flex items-center justify-center text-2xl font-bold text-gray-500">
                  {vaultInfo.symbol?.slice(0, 2) || '??'}
                </div>
              )}
              <div className="absolute inset-0 border-4 border-white/5 pointer-events-none" />
            </div>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-black uppercase italic text-white tracking-tighter truncate pr-2">
                  {vaultInfo.name}
                </h1>
                <span className="text-xs font-mono font-bold text-primary bg-primary/10 px-2.5 border border-primary/20 shrink-0 h-6 flex items-center">
                  ${vaultInfo.symbol}
                </span>
                {isLeader && (
                  <span className="text-xs font-bold text-green-400 bg-green-400/10 px-2.5 border border-green-400/20 uppercase tracking-wider shrink-0 h-6 flex items-center">
                    Leader
                  </span>
                )}
                <span className="text-xs font-bold text-blue-400 bg-blue-400/10 px-2.5 border border-blue-400/20 uppercase tracking-wider shrink-0 h-6 flex items-center">
                  Fee: {(parseInt(vaultInfo.feeBps || '0') / 100).toFixed(2)}%
                </span>
              </div>

              <div className="flex items-center gap-3 mt-2">
                <button
                  onClick={() => copyToClipboard(vaultInfo.address, 'contract')}
                  className="text-xs font-mono uppercase tracking-[0.2em] cursor-pointer hover:text-white group flex items-center gap-1"
                >
                  <span className="text-gray-500">Contract: </span>
                  <span className="text-primary group-hover:text-white">
                    {vaultInfo.address.slice(0, 6)}...{vaultInfo.address.slice(-4)}
                  </span>
                  <Copy size={10} className="text-gray-500 group-hover:text-white" />
                  {copiedAddress === 'contract' && <span className="text-green-400 ml-1">✓</span>}
                </button>
                <button
                  onClick={() => copyToClipboard(vaultInfo.leader, 'leader')}
                  className="text-xs font-mono uppercase tracking-[0.2em] cursor-pointer hover:text-white group flex items-center gap-1"
                >
                  <span className="text-gray-500">Leader: </span>
                  <span className="text-primary group-hover:text-white">
                    {vaultInfo.leader.slice(0, 6)}...{vaultInfo.leader.slice(-4)}
                  </span>
                  <Copy size={10} className="text-gray-500 group-hover:text-white" />
                  {copiedAddress === 'leader' && <span className="text-green-400 ml-1">✓</span>}
                </button>
              </div>
            </div>
          </div>

          {/* Right stats grid */}
          <div className="flex gap-6 bg-black/40 border border-white/5 p-4 backdrop-blur-sm">
            <BigStat
              label="MCap"
              value={`$${(parseFloat(vaultInfo.buyPrice || '0') * parseFloat(vaultInfo.totalSupply || '0')).toFixed(2)}`}
              accent="text-white"
            />
            {totalAssets !== undefined && (
              <BigStat label="Assets" value={`$${totalAssets.toFixed(2)}`} accent="text-cyan-400" />
            )}
            <BigStat label="Supply" value={parseFloat(vaultInfo.totalSupply || '0').toFixed(2)} accent="text-white" />
            <BigStat label="Buy" value={`$${parseFloat(vaultInfo.buyPrice || '0').toFixed(4)}`} accent="text-primary" />
            <BigStat label="Sell" value={`$${parseFloat(vaultInfo.sellPrice || '0').toFixed(4)}`} accent="text-red-400" />
            <BigStat label="NAV" value={`$${parseFloat(vaultInfo.nav || '0').toFixed(4)}`} accent="text-white" />
          </div>
        </div>
      </div>
    );
  }

  // Loading
  if (isLoading) {
    return (
      <div className="bg-card border-b border-border py-4 px-6">
        <div className="flex gap-4 items-center">
          <button
            onClick={() => router.push('/')}
            className="w-10 h-10 flex cursor-pointer items-center justify-center border border-border hover:bg-white/5 transition-all text-gray-500 hover:text-white"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 flex items-center justify-center py-3">
            <div className="flex items-center gap-3">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-gray-400 font-mono">Loading vault...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Not found — vault input fallback
  return (
    <div className="bg-card border-b border-border py-8 px-6">
      <div className="flex flex-col gap-4 items-center">
        <div className="w-full flex gap-4 items-center">
          <button
            onClick={() => router.push('/')}
            className="w-10 h-10 flex cursor-pointer items-center justify-center border border-border hover:bg-white/5 transition-all text-gray-500 hover:text-white"
          >
            <ArrowLeft size={20} />
          </button>
          <input
            type="text"
            value={vaultAddress}
            onChange={(e) => onVaultAddressChange(e.target.value)}
            className="flex-1 bg-black border border-border px-4 py-3 font-mono text-sm outline-none focus:border-primary transition-all"
            placeholder="Enter vault address (base58)"
          />
          <button
            onClick={onLoadVault}
            className="bg-primary text-black px-6 py-3 font-black uppercase tracking-widest text-sm hover:brightness-110 transition-all"
          >
            Load Vault
          </button>
        </div>
        <p className="text-gray-500 text-sm mt-4 font-black uppercase tracking-widest">
          Cannot find vault. Try again or contact support.
        </p>
      </div>
    </div>
  );
}

function BigStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="flex flex-col p-1">
      <span className="text-xs font-black text-gray-500 uppercase tracking-widest mb-1">
        {label}
      </span>
      <span className={`text-xl font-mono font-bold tracking-tighter ${accent}`}>
        {value}
      </span>
    </div>
  );
}
