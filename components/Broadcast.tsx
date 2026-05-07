'use client';

import { useEffect, useState } from 'react';

interface Vault {
  name: string;
  symbol: string;
  priceChange: number;
}

export default function Broadcast() {
  const [vaults, setVaults] = useState<Vault[]>([]);

  useEffect(() => {
    const fetchVaults = async () => {
      try {
        const response = await fetch('/api/vaults/recent');
        if (response.ok) {
          const data = await response.json();
          // API may return either an array or { data: [...] } when paginated
          const list = Array.isArray(data) ? data : (data?.data ?? []);
          setVaults(list);
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
