'use client'

import React, { useState, useMemo, useEffect } from 'react';
import { LayoutGrid, List, RefreshCw } from 'lucide-react';
import { Token } from '@/types';
import TokenCard from '@/components/TokenCard';
import Broadcast from '@/components/Broadcast';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import HeroSection from '@/components/HeroSection';
import SEOContent from '@/components/SEOContent';
import { loadVaults, VaultInfo } from '@/lib/vaults';

type SortOption = 'newest' | 'tvl' | 'winRate' | 'apy' | 'priceUp' | 'priceDown';

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'tvl', label: 'TVL' },
  { value: 'winRate', label: 'Win Rate' },
  { value: 'apy', label: 'APY' },
  { value: 'priceUp', label: 'Price ↑' },
  { value: 'priceDown', label: 'Price ↓' },
];

export default function Home() {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'new'>('all');
  const [sortBy, setSortBy] = useState<SortOption>('tvl');
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 40;

  const fetchVaults = async (forceRefresh?: boolean) => {
    try {
      setLoading(true);
      setError(null);
      const data = await loadVaults((coreAddress, updates) => {
        // Update vault data when loaded (images, positions, metrics)
        setVaults(prev => prev.map(vault =>
          vault.core.toLowerCase() === coreAddress.toLowerCase() ? { ...vault, ...updates } : vault
        ));
      }, forceRefresh);
      setVaults(data);
    } catch (error) {
      console.error('Failed to load vaults:', error);
      setError(error instanceof Error ? error.message : 'Failed to load vault information. Please check your network connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVaults();
  }, []);


  const tokens = useMemo((): Token[] => {
    return vaults.map((vault) => ({
      id: vault.core,
      name: vault.name,
      symbol: vault.symbol,
      description: `Performance Fee: ${vault.performanceFeeBps / 100}%`,
      imageUrl: vault.imageUrl || 'images/cannot_find_image.jpg',
      marketCap: parseFloat(vault.tvl),
      bondingCurveProgress: Math.min((parseFloat(vault.totalSupply) / 1000000) * 100, 100),
      price: parseFloat(vault.buyPrice),
      holders: 0,
      creator: vault.leader,
      createdAt: vault.createdAt,
      volume24h: parseFloat(vault.totalVolume),
      priceChange24h: vault.priceChange24h,
      priceChange: vault.priceChange, // Use price change from first trade
      nav: vault.nav,
      buyPrice: vault.buyPrice,
      performanceFeeBps: vault.performanceFeeBps,
      tvl: vault.tvl,
      totalVolume: vault.totalVolume,
      leader: vault.leader,
      positions: vault.positions,
      winRate: vault.winRate,
      apy: vault.apy,
    }));
  }, [vaults]);

  const filteredTokens = useMemo(() => {
    const filtered = tokens.filter(t =>
      (t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.symbol.toLowerCase().includes(searchQuery.toLowerCase())) &&
      (activeTab === 'all' ||
        (activeTab === 'new' && t.bondingCurveProgress < 20))
    );

    // Sort tokens - specific tabs override sort options
    return [...filtered].sort((a, b) => {
      if (activeTab === 'new') {
        return (b.createdAt || 0) - (a.createdAt || 0);
      }

      switch (sortBy) {
        case 'tvl':
          return parseFloat(b.tvl || '0') - parseFloat(a.tvl || '0');
        case 'winRate':
          return (b.winRate || 0) - (a.winRate || 0);
        case 'apy':
          return (b.apy || 0) - (a.apy || 0);
        case 'priceUp':
          return (b.priceChange24h || 0) - (a.priceChange24h || 0);
        case 'priceDown':
          return (a.priceChange24h || 0) - (b.priceChange24h || 0);
        case 'newest':
        default:
          return (b.createdAt || 0) - (a.createdAt || 0);
      }
    });
  }, [tokens, searchQuery, activeTab, sortBy]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, activeTab, sortBy]);

  // Pagination
  const totalPages = Math.ceil(filteredTokens.length / itemsPerPage);
  const paginatedTokens = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredTokens.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredTokens, currentPage, itemsPerPage]);

  return (
    <div className="min-h-screen bg-dark flex flex-col text-white selection:bg-primary/30">
      <Broadcast />
      <Header
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onLogoClick={() => window.location.href = '/'}
      />

      <main className="flex-1 w-full mx-auto px-2 sm:px-4">

        <div className="p-2 sm:p-4 space-y-3 sm:space-y-6">
          <HeroSection />

          {/* DASHBOARD CONTROLS */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 border-y border-border py-3 sm:py-6">
            {/* Tabs - full width on mobile */}
            {/*<div className="flex items-center bg-white/5 p-0.5 sm:p-1">
              {([
                { value: 'all', label: 'ALL' },
                { value: 'new', label: 'NEW' }
              ] as const).map(tab => (
                <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  className={`cursor-pointer flex-1 sm:flex-none px-4 sm:px-8 py-1.5 sm:py-2 text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all ${activeTab === tab.value ? 'bg-primary text-black shadow-[0_0_10px_#50d2c140]' : 'text-gray-500 hover:text-white'}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>*/}
            {/* Sort buttons */}
            <div className="flex items-center bg-white/5 p-0.5 sm:p-1">
              {SORT_OPTIONS.map(option => (
                <button
                  key={option.value}
                  onClick={() => setSortBy(option.value)}
                  className={`cursor-pointer px-2 sm:px-4 py-1.5 sm:py-2 text-[10px] sm:text-xs font-black uppercase tracking-widest transition-all ${sortBy === option.value
                    ? 'bg-primary text-black shadow-[0_0_10px_#50d2c140]'
                    : 'text-gray-500 hover:text-white'
                    }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {/* buttons + Refresh */}
            <div className="flex items-center gap-2 sm:gap-4 hidden md:flex">
              {/* View toggle - hidden on mobile */}
              <div className="hidden sm:flex items-center border border-border h-10">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`px-5 cursor-pointer h-full border-r border-border ${viewMode === 'grid' ? 'text-primary bg-primary/10' : 'text-gray-500'}`}
                >
                  <LayoutGrid size={14} />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-5 cursor-pointer h-full ${viewMode === 'list' ? 'text-primary bg-primary/10' : 'text-gray-500'}`}
                >
                  <List size={14} />
                </button>
              </div>
              {/* Refresh button */}
              <button
                onClick={() => fetchVaults(true)}
                disabled={loading}
                className={`flex items-center justify-center w-8 h-8 sm:w-10 sm:h-10 border border-border hover:border-primary/40 transition-colors ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                title="Refresh data"
              >
                <RefreshCw size={14} className={`text-gray-500 hover:text-primary ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* ASSET GRID */}
          <div className={viewMode === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 [&]:[@media(min-width:2100px)]:grid-cols-4 gap-2 sm:gap-6 overflow-hidden' : 'flex flex-col gap-2 sm:gap-4'}>
            {loading ? (
              // Skeleton loader to reduce CLS
              <>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="bg-surface border border-border animate-pulse">
                    <div className="flex flex-col sm:flex-row">
                      {/* Mobile skeleton */}
                      <div className="sm:hidden p-2 border-b border-border">
                        <div className="flex items-center gap-2">
                          <div className="w-10 h-10 bg-gray-800 rounded" />
                          <div className="flex-1">
                            <div className="h-4 bg-gray-800 rounded w-24 mb-1" />
                            <div className="h-3 bg-gray-800 rounded w-16" />
                          </div>
                        </div>
                      </div>
                      {/* Desktop skeleton */}
                      <div className="hidden sm:block w-48 sm:w-64 h-48 bg-gray-800" />
                      <div className="hidden sm:flex flex-1 p-3 flex-col">
                        <div className="h-6 bg-gray-800 rounded w-32 mb-2" />
                        <div className="h-4 bg-gray-800 rounded w-20 mb-4" />
                        <div className="grid grid-cols-3 gap-1.5 flex-1">
                          {Array.from({ length: 6 }).map((_, j) => (
                            <div key={j} className="bg-gray-800/50 p-2 h-14 rounded" />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            ) : error ? (
              <div className="col-span-full">
                <div className="max-w-2xl mx-auto text-center py-20 space-y-4">
                  <div className="text-red-500 text-xl font-bold">⚠️ Error Loading Vaults</div>
                  <div className="text-gray-400 text-sm bg-red-500/10 border border-red-500/20 rounded p-6">
                    {error}
                  </div>
                  <button
                    onClick={() => window.location.reload()}
                    className="mt-4 px-6 py-2 bg-primary text-black font-bold text-xs uppercase tracking-widest hover:bg-primary/80 transition-colors"
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : filteredTokens.length === 0 ? (
              <div className="col-span-full text-center py-20 text-gray-500">No vaults found</div>
            ) : (
              paginatedTokens.map((token) => (
                <TokenCard key={token.id} token={token} viewMode={viewMode} />
              ))
            )}
          </div>

          {/* PAGINATION */}
          {!loading && !error && filteredTokens.length > 0 && totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 py-8 pb-20">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className={`px-4 py-2 border border-border text-xs font-bold uppercase tracking-widest transition-colors ${
                  currentPage === 1
                    ? 'opacity-30 cursor-not-allowed'
                    : 'hover:border-primary/40 hover:text-primary cursor-pointer'
                }`}
              >
                Previous
              </button>

              <div className="flex items-center gap-1">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => {
                  // Show first page, last page, current page, and pages around current
                  const shouldShow =
                    page === 1 ||
                    page === totalPages ||
                    Math.abs(page - currentPage) <= 1;

                  const shouldShowEllipsis =
                    (page === 2 && currentPage > 3) ||
                    (page === totalPages - 1 && currentPage < totalPages - 2);

                  if (!shouldShow && !shouldShowEllipsis) return null;

                  if (shouldShowEllipsis) {
                    return (
                      <span key={page} className="px-2 text-gray-500">
                        ...
                      </span>
                    );
                  }

                  return (
                    <button
                      key={page}
                      onClick={() => setCurrentPage(page)}
                      className={`px-3 py-2 text-xs font-bold uppercase tracking-widest transition-all cursor-pointer ${
                        currentPage === page
                          ? 'bg-primary text-black'
                          : 'border border-border hover:border-primary/40 hover:text-primary'
                      }`}
                    >
                      {page}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className={`px-4 py-2 border border-border text-xs font-bold uppercase tracking-widest transition-colors ${
                  currentPage === totalPages
                    ? 'opacity-30 cursor-not-allowed'
                    : 'hover:border-primary/40 hover:text-primary cursor-pointer'
                }`}
              >
                Next
              </button>
            </div>
          )}
        </div>

        {/* SEO Content Section */}
        <SEOContent />
      </main>

      <Footer />
    </div>
  );
}
