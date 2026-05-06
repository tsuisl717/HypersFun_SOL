'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import Broadcast from '@/components/Broadcast';

export default function SwapPage() {
  const router = useRouter();
  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Broadcast />
      <Header searchQuery="" onSearchChange={() => {}} onLogoClick={() => router.push('/')} />
      <main className="flex-1 flex flex-col items-center justify-center px-4 py-20 gap-6">
        <div className="border border-primary/20 bg-primary/5 p-8 max-w-lg w-full text-center space-y-4">
          <div className="text-xs font-mono text-primary uppercase tracking-widest">Coming Soon</div>
          <h1 className="text-2xl font-black uppercase italic text-white">Swap</h1>
          <p className="text-sm text-gray-400 font-mono">Swap will be available on Solana soon.</p>
        </div>
        <button onClick={() => router.push('/')} className="flex items-center gap-2 text-xs font-bold text-gray-400 hover:text-primary uppercase tracking-widest transition-colors">
          <ArrowLeft size={14} /> Back
        </button>
      </main>
      <Footer />
    </div>
  );
}
