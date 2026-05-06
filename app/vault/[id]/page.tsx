'use client';

import { useCallback, useEffect, useState, use } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { Loader2 } from 'lucide-react';

import Header from '@/components/Header';
import Footer from '@/components/Footer';
import Broadcast from '@/components/Broadcast';
import HeroBar from '@/components/vault-detail/HeroBar';
import ChartPanel from '@/components/vault-detail/ChartPanel';
import TradePanel from '@/components/vault-detail/TradePanel';
import ActivityTabs from '@/components/vault-detail/ActivityTabs';
import AdminPanel from '@/components/vault-detail/AdminPanel';
import OnChainAccounts from '@/components/vault-detail/OnChainAccounts';

import { SOLANA_CONFIG } from '@/lib/contracts/config';
import { loadVaultByAddress, type VaultInfo } from '@/lib/vaults';
import { countHolders, readVaultMintSupply } from '@/lib/vault-trading';

const connection = new Connection(SOLANA_CONFIG.rpcUrl, 'confirmed');

type PageTab = 'trading' | 'report';

export default function VaultDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [vault, setVault]     = useState<VaultInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [holders, setHolders] = useState<number | null>(null);
  const [supply, setSupply]   = useState<string | null>(null);

  const [pageTab, setPageTab] = useState<PageTab>('trading');

  const loadVault = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      try { new PublicKey(id); } catch {
        setError('Invalid vault address.');
        if (!silent) setLoading(false);
        return;
      }
      const v = await loadVaultByAddress(id);
      if (!v) { if (!silent) setError('Vault not found.'); setVault(null); }
      else    { setVault(v); }
    } catch (e: any) {
      if (!silent) setError(e?.message ?? 'Failed to load vault.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id]);

  const loadAux = useCallback(async (corePubkey: string) => {
    try {
      const pk = new PublicKey(corePubkey);
      const [h, s] = await Promise.all([
        countHolders(connection, pk),
        readVaultMintSupply(connection, pk),
      ]);
      setHolders(h);
      setSupply(s.supply);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadVault(); }, [loadVault]);
  useEffect(() => { if (vault?.core) loadAux(vault.core); }, [vault?.core, loadAux]);

  const onChange = useCallback(() => {
    loadVault({ silent: true });
    if (vault?.core) loadAux(vault.core);
  }, [loadVault, loadAux, vault?.core]);

  return (
    <div className="min-h-screen bg-dark flex flex-col text-white selection:bg-primary/30">
      <Broadcast />
      <Header
        searchQuery=""
        onSearchChange={() => {}}
        onLogoClick={() => { window.location.href = '/'; }}
      />

      <main className="flex-1 w-full max-w-[1600px] mx-auto px-2 sm:px-4 py-3 sm:py-4 space-y-3">
        {loading && (
          <div className="flex items-center justify-center py-32 text-gray-400 font-mono text-sm">
            <Loader2 size={16} className="animate-spin mr-2" /> Loading vault…
          </div>
        )}

        {!loading && error && (
          <div className="border border-red-500/40 bg-red-500/5 p-8 text-center">
            <div className="text-red-400 font-bold uppercase tracking-widest text-sm mb-2">{error}</div>
            <div className="text-xs font-mono text-gray-500 break-all">{id}</div>
          </div>
        )}

        {!loading && !error && vault && (
          <>
            <HeroBar vault={vault} holders={holders} totalSupply={supply} />

            {/* Page-tab strip */}
            <div className="flex items-center gap-0 border-b border-border">
              <PageTabBtn active={pageTab === 'trading'} onClick={() => setPageTab('trading')} label="Trading" />
              <PageTabBtn active={pageTab === 'report'}  onClick={() => setPageTab('report')}  label="Report" />
              <div className="ml-auto flex items-center gap-2 px-3 text-[10px] font-mono uppercase tracking-widest">
                <span className="text-gray-500">SOL</span>
                <span className="px-2 py-0.5 border border-primary/30 text-primary font-bold">
                  {SOLANA_CONFIG.network}
                </span>
              </div>
            </div>

            {pageTab === 'trading' ? (
              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-3">
                {/* Left column */}
                <div className="flex flex-col gap-3 min-w-0">
                  <ChartPanel vault={vault} />
                  <ActivityTabs vault={vault} holders={holders} />
                </div>

                {/* Right column */}
                <div className="flex flex-col gap-3 min-w-0">
                  <TradePanel vault={vault} totalSupply={supply} onTradeComplete={onChange} />
                  <OnChainAccounts vault={vault} />
                  <AdminPanel vault={vault} onChange={onChange} />
                </div>
              </div>
            ) : (
              <div className="border border-border bg-surface p-10 text-center text-xs font-mono text-gray-500">
                Report view coming soon.
              </div>
            )}
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}

function PageTabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-5 py-2.5 text-xs font-mono font-bold uppercase tracking-widest transition-colors ${
        active ? 'text-primary border-b-2 border-primary -mb-px' : 'text-gray-500 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}
