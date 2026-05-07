'use client';

import { useState, useEffect } from 'react';
import { loadVaults } from '@/lib/vaults';

function formatTVL(tvl: number): string {
  if (tvl === 0) return '$0';
  if (tvl >= 1_000_000_000) return `$${(tvl / 1_000_000_000).toFixed(2)}B`;
  if (tvl >= 1_000_000) return `$${(tvl / 1_000_000).toFixed(2)}M`;
  if (tvl >= 1_000) return `$${(tvl / 1_000).toFixed(2)}K`;
  return `$${tvl.toFixed(2)}`;
}

export function useFactoryStats() {
  const [stats, setStats] = useState({
    totalVaults: 0,
    verifiedVaultsCount: 0,
    neuralTVL: 0,
    neuralTVLFormatted: '$0',
    creationFeeUSDC: 0,
    tradingFeeBps: 100,
    tradingFeePercent: '1.00%',
    minDepositUSDC: 10,
    isLoadingTVL: true,
  });

  useEffect(() => {
    loadVaults().then(vaults => {
      const totalTVL = vaults.reduce((sum, v) => sum + parseFloat(v.tvl || '0'), 0);
      const verified = 0;
      setStats({
        totalVaults: vaults.length,
        verifiedVaultsCount: verified,
        neuralTVL: totalTVL,
        neuralTVLFormatted: formatTVL(totalTVL),
        creationFeeUSDC: 10,
        tradingFeeBps: 100,
        tradingFeePercent: '1.00%',
        minDepositUSDC: 10,
        isLoadingTVL: false,
      });
    }).catch(() => {
      setStats(prev => ({ ...prev, isLoadingTVL: false }));
    });
  }, []);

  return stats;
}

export function useTopVaults(limit = 10) {
  const [topVaults, setTopVaults] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadVaults().then(vaults => {
      const sorted = [...vaults]
        .sort((a, b) => parseFloat(b.tvl || '0') - parseFloat(a.tvl || '0'))
        .slice(0, limit)
        .map(v => ({
          address: v.address,
          name: v.name,
          symbol: v.symbol,
          leader: v.leader,
          tvl: parseFloat(v.tvl || '0'),
          tvlFormatted: formatTVL(parseFloat(v.tvl || '0')),
          performanceFeeBps: v.performanceFeeBps,
          verified: false,
          createdAt: 0,
        }));
      setTopVaults(sorted);
      setIsLoading(false);
    }).catch(() => setIsLoading(false));
  }, [limit]);

  return { topVaults, isLoading };
}
