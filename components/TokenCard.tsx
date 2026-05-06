'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Token } from '../types';
import { ShieldCheck, Activity, ArrowUpRight, ArrowDownRight } from 'lucide-react';

interface TokenCardProps {
  token: Token;
  viewMode?: 'grid' | 'list';
}

const TokenCard: React.FC<TokenCardProps> = ({ token, viewMode = 'grid' }) => {
  const priceChange = token.priceChange || 0;
  const isUp = priceChange > 0;
  const isFlat = priceChange === 0;
  const [imageError, setImageError] = useState(false);

  return (
    <Link
      href={`/vault/${token.id}`}
      className="group bg-surface hover:bg-card border border-border hover:border-primary/40 transition-all cursor-pointer duration-200 flex flex-col sm:flex-row overflow-hidden metallic-glow"
    >
      {/* Mobile only: Compact header row */}
      <div className={viewMode === 'list' ? 'hidden' : 'sm:hidden flex items-center gap-2 p-2 border-b border-border bg-black/40'}>
        {/* Small image */}
        <div className="w-10 h-10 border border-border bg-black relative shrink-0 overflow-hidden">
          {token.imageUrl && !imageError ? (
            token.imageUrl.startsWith('data:') ? (
              <img
                src={token.imageUrl}
                alt={token.name}
                className="w-full h-full object-cover"
                onError={() => setImageError(true)}
              />
            ) : (
              <Image
                src={token.imageUrl}
                alt={token.name}
                fill
                sizes="40px"
                className="object-cover"
                onError={() => setImageError(true)}
                unoptimized={!token.imageUrl.includes('mypinata.cloud')}
              />
            )
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5">
              <span className="text-sm font-black text-primary/60 uppercase italic">
                {token.symbol?.slice(0, 2) || "?"}
              </span>
            </div>
          )}
        </div>
        {/* Name + Symbol */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-black text-white truncate uppercase italic tracking-tight leading-none">
            {token.name}
          </h3>
          <span className="text-[10px] font-mono font-bold text-gray-400 uppercase">
            ${token.symbol}
          </span>
        </div>
        {/* Price change badge */}
        <div className={`px-1.5 py-0.5 border text-[10px] font-mono font-bold flex items-center gap-1 ${isFlat ? 'border-yellow-400/30 text-yellow-400' : isUp ? 'border-primary/30 text-primary' : 'border-red-500/30 text-red-500'
          }`}>
          {isFlat ? (
            <Activity size={10} />
          ) : isUp ? (
            <ArrowUpRight size={10} />
          ) : (
            <ArrowDownRight size={10} />
          )}
          {isUp ? '+' : ''}{priceChange.toFixed(1)}%
        </div>
        {/* Fee badge */}
        <div className="px-1.5 py-0.5 border bg-primary/10 border-primary/30 text-[10px] font-mono font-bold text-primary">
          {((token.performanceFeeBps || 0) / 100).toFixed(0)}%
        </div>
      </div>

      {/* Mobile only: Stats rows */}
      <div className={viewMode === 'list' ? 'hidden' : 'sm:hidden'}>
        {/* Row 1: Price stats */}
        <div className="grid grid-cols-4 gap-px bg-border">
          <div className="bg-black/60 p-1.5 text-center">
            <p className="text-[8px] text-lime-400/60 font-bold uppercase">NAV</p>
            <p className="text-[10px] font-mono font-bold text-lime-400">${parseFloat(token.nav || '0').toFixed(4)}</p>
          </div>
          <div className="bg-black/60 p-1.5 text-center">
            <p className="text-[8px] text-primary/60 font-bold uppercase">Buy</p>
            <p className="text-[10px] font-mono font-bold text-white">${parseFloat(token.buyPrice || '0').toFixed(4)}</p>
          </div>
          <div className="bg-black/60 p-1.5 text-center">
            <p className="text-[8px] text-primary/60 font-bold uppercase">TVL</p>
            <p className="text-[10px] font-mono font-bold text-primary">${parseFloat(token.tvl || '0').toFixed(0)}</p>
          </div>
          <div className="bg-black/60 p-1.5 text-center">
            <p className="text-[8px] text-amber-300/60 font-bold uppercase">Vol</p>
            <p className="text-[10px] font-mono font-bold text-amber-300">${parseFloat(token.totalVolume || '0').toFixed(0)}</p>
          </div>
        </div>
        {/* Row 2: APY + Win Rate + Leader */}
        <div className="grid grid-cols-4 gap-px bg-border">
          <div className="bg-black/60 p-1.5 text-center">
            <p className="text-[8px] text-cyan-400/60 font-bold uppercase">APY</p>
            <p className={`text-[10px] font-mono font-bold ${(token.apy || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {(token.apy || 0) >= 0 ? '+' : ''}{(token.apy || 0).toFixed(0)}%
            </p>
          </div>
          <div className="bg-black/60 p-1.5 text-center">
            <p className="text-[8px] text-blue-400/60 font-bold uppercase">Win</p>
            <p className="text-[10px] font-mono font-bold text-white">{((token.winRate || 0) * 100).toFixed(0)}%</p>
          </div>
          <div className="bg-black/60 p-1.5 text-center">
            <p className="text-[8px] text-gray-500 font-bold uppercase">Leader</p>
            <p className="text-[9px] font-mono text-gray-400 truncate">
              {token.leader?.slice(0, 4)}..{token.leader?.slice(-3)}
            </p>
          </div>
          <div className="bg-black/60 p-1.5 text-center">
            <p className="text-[8px] text-gray-500 font-bold uppercase">Date</p>
            <p className="text-[9px] font-mono text-gray-400">
              {new Date((token.createdAt || 0) * 1000).toLocaleDateString('en-CA').slice(5)}
            </p>
          </div>
        </div>
        {/* Row 3: L1 Positions */}
        {token.positions && token.positions.length > 0 && (
          <div className="flex items-center gap-1 px-2 py-1 bg-black/50 border-t border-border/50 overflow-x-auto">
            <span className="text-[8px] text-purple-400/60 font-bold uppercase shrink-0">L1:</span>
            <div className="flex items-center gap-1">
              {token.positions.slice(0, 4).map((pos, idx) => (
                <div
                  key={idx}
                  className={`px-1 py-0.5 text-[8px] font-mono font-bold border ${pos.isLong
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-red-500/10 border-red-500/30 text-red-400'
                    }`}
                >
                  {pos.isLong ? '↑' : '↓'}{pos.coin}
                </div>
              ))}
              {token.positions.length > 4 && (
                <span className="text-[8px] text-gray-500 font-mono">+{token.positions.length - 4}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* List mode: Compact single row */}
      {viewMode === 'list' && (
        <div className="hidden sm:flex flex-col w-full bg-gradient-to-r from-black/40 to-black/20">
          {/* Main row */}
          <div className="flex items-center gap-3 p-3">
            {/* Image + Name */}
            <div className="flex items-center gap-3 w-[180px] shrink-0">
              <div className="w-12 h-12 border border-border bg-black relative overflow-hidden">
                {token.imageUrl && !imageError ? (
                  token.imageUrl.startsWith('data:') ? (
                    <img
                      src={token.imageUrl}
                      alt={token.name}
                      className="w-full h-full object-cover"
                      onError={() => setImageError(true)}
                    />
                  ) : (
                    <Image
                      src={token.imageUrl}
                      alt={token.name}
                      fill
                      sizes="48px"
                      className="object-cover"
                      onError={() => setImageError(true)}
                      unoptimized={!token.imageUrl.includes('mypinata.cloud')}
                    />
                  )
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5">
                    <span className="text-sm font-black text-primary/60 uppercase italic">
                      {token.symbol?.slice(0, 2) || "?"}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-black text-white truncate uppercase italic leading-tight">
                  {token.name}
                </h3>
                <span className="text-[10px] font-mono font-bold text-gray-400 uppercase">
                  ${token.symbol}
                </span>
              </div>
            </div>

            {/* Stats - 6 columns */}
            <div className="flex items-center gap-3 flex-1">
              <div className="flex-1 text-center min-w-[70px]">
                <p className="text-[9px] text-lime-400/60 font-bold uppercase mb-0.5">NAV</p>
                <p className="text-xs font-mono font-bold text-lime-400">${parseFloat(token.nav || '0').toFixed(4)}</p>
              </div>
              <div className="flex-1 text-center min-w-[70px]">
                <p className="text-[9px] text-primary/60 font-bold uppercase mb-0.5">TVL</p>
                <p className="text-xs font-mono font-bold text-primary">${parseFloat(token.tvl || '0').toFixed(0)}</p>
              </div>
              <div className="flex-1 text-center min-w-[70px]">
                <p className="text-[9px] text-amber-300/60 font-bold uppercase mb-0.5">Vol</p>
                <p className="text-xs font-mono font-bold text-amber-300">${parseFloat(token.totalVolume || '0').toFixed(0)}</p>
              </div>
              <div className="flex-1 text-center min-w-[70px]">
                <p className="text-[9px] text-cyan-400/60 font-bold uppercase mb-0.5">APY</p>
                <p className={`text-xs font-mono font-bold ${(token.apy || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {(token.apy || 0) >= 0 ? '+' : ''}{(token.apy || 0).toFixed(0)}%
                </p>
              </div>
              <div className="flex-1 text-center min-w-[60px]">
                <p className="text-[9px] text-blue-400/60 font-bold uppercase mb-0.5">Win</p>
                <p className="text-xs font-mono font-bold text-white">{((token.winRate || 0) * 100).toFixed(0)}%</p>
              </div>
              <div className="flex-1 text-center min-w-[60px]">
                <p className="text-[9px] text-gray-500/60 font-bold uppercase mb-0.5">24h</p>
                <div className={`text-xs font-mono font-bold ${isFlat ? 'text-yellow-400' : isUp ? 'text-primary' : 'text-red-500'}`}>
                  {isUp ? '+' : ''}{priceChange.toFixed(1)}%
                </div>
              </div>
            </div>

            {/* Leader */}
            <div className="w-[100px] shrink-0 text-center">
              <p className="text-[9px] text-gray-500/60 font-bold uppercase mb-0.5">Leader</p>
              <p className="text-[10px] font-mono text-gray-400">
                {token.leader?.slice(0, 4)}..{token.leader?.slice(-3)}
              </p>
            </div>

            {/* Date */}
            <div className="w-[80px] shrink-0 text-center">
              <p className="text-[9px] text-gray-500/60 font-bold uppercase mb-0.5">Date</p>
              <p className="text-[10px] font-mono text-gray-400">
                {new Date((token.createdAt || 0) * 1000).toLocaleDateString('en-CA').slice(5)}
              </p>
            </div>

            {/* Fee badge */}
            <div className="px-3 py-1.5 border bg-primary/10 border-primary/30 shrink-0">
              <div className="text-[10px] font-mono font-bold text-primary">
                Fee: {((token.performanceFeeBps || 0) / 100).toFixed(0)}%
              </div>
            </div>
          </div>

          {/* L1 Positions Row */}
          <div className="flex items-center gap-2 px-3 pb-2 border-t border-border/30 pt-2">
            <div className="text-[9px] text-purple-400/60 font-bold uppercase shrink-0">
              <span className='mr-1'>L1</span>
              <span>Positions:</span>
            </div>
            {token.positions && token.positions.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {token.positions.slice(0, 8).map((pos, idx) => (
                  <div
                    key={idx}
                    className={`px-1.5 py-0.5 text-[9px] font-mono font-bold border ${pos.isLong
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-red-500/10 border-red-500/30 text-red-400'
                      }`}
                  >
                    {pos.isLong ? '↑' : '↓'}{pos.coin}
                  </div>
                ))}
                {token.positions.length > 8 && (
                  <span className="text-[9px] text-gray-500 font-mono">+{token.positions.length - 8}</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Desktop: Large Image on the Left */}
      <div className={viewMode === 'list' ? 'hidden' : 'hidden sm:block w-48 sm:w-64 h-full border-r border-border bg-black relative shrink-0 overflow-hidden'}>
        {token.imageUrl && !imageError ? (
          token.imageUrl.startsWith('data:') ? (
            <img
              src={token.imageUrl}
              alt={token.name}
              className="w-full h-full object-cover transition-all duration-500 group-hover:scale-110"
              onError={() => setImageError(true)}
            />
          ) : (
            <Image
              src={token.imageUrl}
              alt={token.name}
              fill
              sizes="(max-width: 640px) 192px, 256px"
              className="object-cover transition-all duration-500 group-hover:scale-110"
              onError={() => setImageError(true)}
              unoptimized={!token.imageUrl.includes('mypinata.cloud')}
            />
          )
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5">
            <span className="text-4xl font-black text-primary/60 uppercase italic">
              {token.symbol?.slice(0, 3) || "?"}
            </span>
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

        {/* Status Overlay */}
        <div className="absolute top-2 left-2">
          <div className="bg-black/60 backdrop-blur-md border border-white/10 px-2 py-1 flex items-center gap-1.5">
            {isFlat ? (
              <Activity size={14} className="text-yellow-400" />
            ) : isUp ? (
              <ArrowUpRight size={14} className="text-primary" />
            ) : (
              <ArrowDownRight size={14} className="text-red-500" />
            )}
            <span className={`text-xs font-mono font-bold uppercase tracking-tight ${isFlat ? 'text-yellow-400' : isUp ? 'text-primary' : 'text-red-500'}`}>
              {isUp ? '+' : ''}{priceChange.toFixed(2)}%
            </span>
          </div>
        </div>
      </div>

      {/* Desktop: Data Section */}
      <div className={viewMode === 'list' ? 'hidden' : 'hidden sm:flex flex-1 p-3 flex-col min-w-0 bg-gradient-to-br from-black/40 to-black/20'}>
        {/* Header */}
        <div className="flex justify-between items-start gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-xl font-black text-white truncate group-hover:text-primary transition-colors uppercase italic tracking-tight leading-none mb-1">
              {token.name}
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono font-bold text-gray-400 uppercase tracking-wider">
                ${token.symbol}
              </span>
              {token.verified && (
                <ShieldCheck size={10} className="text-primary" />
              )}
            </div>
          </div>
          <div className="px-2 py-1 border bg-primary/10 border-primary/30">
            <div className="flex items-center gap-1 font-mono text-xs font-bold text-primary">
              Fee:{((token.performanceFeeBps || 0) / 100).toFixed(0)}%
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-1.5 flex-1">
          <div className="bg-black/40 backdrop-blur-sm p-2 border border-lime-400/20 hover:border-lime-400/40 transition-colors">
            <p className="text-[9px] text-lime-400/60 font-bold uppercase mb-1 tracking-widest">NAV</p>
            <p className="text-sm font-mono font-bold text-lime-400 leading-none">${parseFloat(token.nav || '0').toFixed(4)}</p>
          </div>
          <div className="bg-black/40 backdrop-blur-sm p-2 border border-primary/20 hover:border-primary/40 transition-colors">
            <p className="text-[9px] text-primary/60 font-bold uppercase mb-1 tracking-widest">Buy</p>
            <p className="text-sm font-mono font-bold text-white leading-none">${parseFloat(token.buyPrice || '0').toFixed(4)}</p>
          </div>
          <div className="bg-black/40 backdrop-blur-sm p-2 border border-primary/20 hover:border-primary/40 transition-colors">
            <p className="text-[9px] text-primary/60 font-bold uppercase mb-1 tracking-widest">TVL</p>
            <p className="text-sm font-mono font-bold text-primary leading-none">${parseFloat(token.tvl || '0').toFixed(2)}</p>
          </div>
          <div className="bg-black/40 backdrop-blur-sm p-2 border border-amber-300/20 hover:border-amber-300/40 transition-colors">
            <p className="text-[9px] text-amber-300/60 font-bold uppercase mb-1 tracking-widest">Vol</p>
            <p className="text-sm font-mono font-bold text-amber-300 leading-none">${parseFloat(token.totalVolume || '0').toFixed(2)}</p>
          </div>
          <div className="bg-black/40 backdrop-blur-sm p-2 border border-cyan-400/20 hover:border-cyan-400/40 transition-colors">
            <p className="text-[9px] text-cyan-400/60 font-bold uppercase mb-1 tracking-widest">APY</p>
            <p className={`text-sm font-mono font-bold leading-none ${(token.apy || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {(token.apy || 0) >= 0 ? '+' : ''}{(token.apy || 0).toFixed(0)}%
            </p>
          </div>
          <div className="bg-black/40 backdrop-blur-sm p-2 border border-blue-400/20 hover:border-blue-400/40 transition-colors">
            <p className="text-[9px] text-blue-400/60 font-bold uppercase mb-1 tracking-widest">Win</p>
            <p className="text-sm font-mono font-bold text-white leading-none">{((token.winRate || 0) * 100).toFixed(0)}%</p>
          </div>
        </div>

        {/* L1 Positions */}
        <div className="mt-2 pt-2 border-t border-purple-500/20">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[9px] text-purple-400/60 font-bold uppercase tracking-widest">L1 Positions</span>
          </div>
          {token.positions && token.positions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {token.positions.slice(0, 6).map((pos, idx) => (
                <div
                  key={idx}
                  className={`px-1.5 py-0.5 text-[10px] font-mono font-bold border ${pos.isLong
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-red-500/10 border-red-500/30 text-red-400'
                    }`}
                >
                  {pos.isLong ? '↑' : '↓'}{pos.coin}
                </div>
              ))}
              {token.positions.length > 6 && (
                <span className="text-[10px] text-gray-500 font-mono self-center">+{token.positions.length - 6}</span>
              )}
            </div>
          )}
        </div>


        {/* Footer */}
        <div className="mt-2 pt-2 border-t border-primary/10 flex justify-between items-center gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-2 h-2 bg-primary rounded-full animate-pulse shadow-[0_0_6px_#50d2c1]" />
            <span className="text-xs font-mono text-gray-400 uppercase tracking-wider truncate">
              {token.leader?.slice(0, 5)}...{token.leader?.slice(-4)}
            </span>
          </div>
          <span className="text-xs font-mono text-gray-500 uppercase tracking-wider shrink-0">
            {new Date((token.createdAt || 0) * 1000).toLocaleDateString('en-CA')}
          </span>
        </div>
      </div>
    </Link>
  );
};

export default TokenCard;
