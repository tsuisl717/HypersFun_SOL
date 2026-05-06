'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import Broadcast from '@/components/Broadcast';

export default function VaultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Broadcast />
      <Header searchQuery="" onSearchChange={() => {}} onLogoClick={() => router.push('/')} />
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-20 gap-6">
        <div className="border border-primary/20 bg-primary/5 p-8 max-w-lg w-full text-center space-y-4">
          <div className="text-xs font-mono text-primary uppercase tracking-widest">Solana Migration</div>
          <h1 className="text-2xl font-black uppercase italic text-white">Vault Detail</h1>
          <p className="text-sm text-gray-400 font-mono">
            On-chain vault data will be available after Solana program deployment.
          </p>
          <div className="text-xs font-mono text-gray-600 break-all bg-black/40 p-3 border border-border">
            {id}
          </div>
        </div>
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-2 text-xs font-bold text-gray-400 hover:text-primary uppercase tracking-widest transition-colors"
        >
          <ArrowLeft size={14} /> Back to Vaults
        </button>
      </main>
      <Footer />
    </div>
  );
}
