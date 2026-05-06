'use client';

import { useEffect, useState } from 'react';
import { getCachedVaults, VaultInfo } from '@/lib/vaults';

interface Vault {
  name: string;
  symbol: string;
  priceChange: number;
}

export default function Broadcast() {
  const [vaults, setVaults] = useState<Vault[]>([]);

  useEffect(() => {
    // Fetch recent vaults data - try cache first, then fallback to API
    const fetchVaults = async () => {
      try {
        // Try to use cached vaults data first (reuse from lib/vaults.ts)
        const cachedVaults = getCachedVaults();
        if (cachedVaults && cachedVaults.length > 0) {
          // Sort by priceChange24h and take top 10
          const sorted = [...cachedVaults]
            .sort((a, b) => Math.abs(b.priceChange24h) - Math.abs(a.priceChange24h))
            .slice(0, 10)
            .map(v => ({
              name: v.name,
              symbol: v.symbol,
              priceChange: v.priceChange24h,
            }));
          setVaults(sorted);
          console.log('[Broadcast] Using cached vaults data');
          return;
        }

        // Fallback to API if cache miss
        const response = await fetch('/api/vaults/recent');
        if (response.ok) {
          const data = await response.json();
          setVaults(data);
        }
      } catch (error) {
        console.error('Failed to fetch vaults:', error);
      }
    };

    fetchVaults();
    const interval = setInterval(fetchVaults, 30000); // Update every 30 seconds
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-black/90 backdrop-blur-md border-b border-primary/20 h-10 flex items-center overflow-hidden z-[60]">
      <div className="animate-marquee whitespace-nowrap flex items-center gap-16">
        {vaults.length > 0 ? (
          vaults.map((vault, i) => (
            <div key={i} className="flex items-center gap-2 text-[10px] font-mono font-bold tracking-widest">
              <span className="text-primary uppercase flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse shadow-[0_0_10px_#10b981]" />
                {vault.name}
              </span>
              <span className="text-primary/40 uppercase">
                <span className="text-white">(${vault.symbol})</span>
              </span>
              <span className={`uppercase ${vault.priceChange >= 0 ? 'text-primary' : 'text-red-500'}`}>
                <span className="font-black">{vault.priceChange >= 0 ? '+' : ''}{vault.priceChange.toFixed(2)}%</span>
              </span>
            </div>
          ))
        ) : (
          <div className="flex items-center text-[10px] font-mono font-bold tracking-widest">
            <span className="text-primary/40 uppercase">Loading vaults data...</span>
          </div>
        )}
      </div>
    </div>
  );
}
