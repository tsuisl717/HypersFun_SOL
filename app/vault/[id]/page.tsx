'use client';

import { use, useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink, ShieldCheck, Globe, Send, Loader2 } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import Broadcast from '@/components/Broadcast';
import { loadVaultByAddress, VaultInfo } from '@/lib/vaults';
import { SOLANA_CONFIG } from '@/lib/contracts/config';

const EXPLORER_BASE = 'https://explorer.solana.com';
const cluster = SOLANA_CONFIG.network === 'mainnet' ? '' : `?cluster=${SOLANA_CONFIG.network}`;
const explorerAddress = (addr: string) => `${EXPLORER_BASE}/address/${addr}${cluster}`;

const shorten = (s: string, head = 6, tail = 4) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

export default function VaultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [vault, setVault]     = useState<VaultInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [imgErr, setImgErr]   = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadVaultByAddress(id)
      .then((v) => {
        if (cancelled) return;
        if (!v) setError('Vault not found on-chain.');
        else setVault(v);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Broadcast />
      <Header searchQuery="" onSearchChange={() => {}} onLogoClick={() => router.push('/')} />

      <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-8">
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-2 text-xs font-bold text-gray-400 hover:text-primary uppercase tracking-widest transition-colors mb-6"
        >
          <ArrowLeft size={14} /> Back to Vaults
        </button>

        {loading && (
          <div className="flex items-center justify-center gap-3 py-32 text-gray-400 font-mono text-sm">
            <Loader2 size={16} className="animate-spin" /> Loading vault from devnet…
          </div>
        )}

        {!loading && error && (
          <div className="border border-red-500/30 bg-red-500/5 p-8 text-center space-y-3">
            <div className="text-red-500 font-bold uppercase text-xs tracking-widest">Error</div>
            <p className="text-sm text-gray-300 font-mono break-all">{error}</p>
            <p className="text-xs text-gray-500 font-mono break-all">{id}</p>
          </div>
        )}

        {!loading && vault && (
          <div className="space-y-6">

            {/* ── Hero ── */}
            <div className="border border-border bg-surface flex flex-col md:flex-row overflow-hidden">
              {/* Image */}
              <div className="relative w-full md:w-72 h-72 md:h-auto bg-black border-b md:border-b-0 md:border-r border-border shrink-0">
                {vault.imageUrl && !imgErr ? (
                  vault.imageUrl.startsWith('data:') ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
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
                      sizes="(max-width: 768px) 100vw, 288px"
                      className="object-cover"
                      onError={() => setImgErr(true)}
                      unoptimized={!vault.imageUrl.includes('mypinata.cloud')}
                    />
                  )
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5">
                    <span className="text-6xl font-black text-primary/60 uppercase italic">
                      {vault.symbol?.slice(0, 3) || '?'}
                    </span>
                  </div>
                )}
              </div>

              {/* Header */}
              <div className="flex-1 p-6 flex flex-col gap-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h1 className="text-3xl font-black uppercase italic text-white truncate">
                        {vault.name || '(no name)'}
                      </h1>
                      {vault.verified && <ShieldCheck size={20} className="text-primary shrink-0" />}
                    </div>
                    <div className="text-sm font-mono font-bold text-gray-400 uppercase tracking-wider">
                      ${vault.symbol}
                    </div>
                  </div>
                  <div className="px-3 py-1.5 border bg-primary/10 border-primary/30 shrink-0">
                    <div className="font-mono text-xs font-bold text-primary">
                      Fee {(vault.performanceFeeBps / 100).toFixed(0)}%
                    </div>
                  </div>
                </div>

                {vault.description && (
                  <p className="text-sm text-gray-300 font-mono leading-relaxed whitespace-pre-wrap">
                    {vault.description}
                  </p>
                )}

                {/* Social links */}
                {(vault.links?.website || vault.links?.twitter || vault.links?.telegram) && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {vault.links.website && (
                      <SocialPill href={vault.links.website} icon={<Globe size={12} />} label="Website" />
                    )}
                    {vault.links.twitter && (
                      <SocialPill href={vault.links.twitter} icon={<span className="text-[10px] font-bold">𝕏</span>} label="Twitter" />
                    )}
                    {vault.links.telegram && (
                      <SocialPill href={vault.links.telegram} icon={<Send size={12} />} label="Telegram" />
                    )}
                  </div>
                )}

                <div className="text-[11px] font-mono text-gray-500">
                  Created {new Date(vault.createdAt * 1000).toLocaleString('en-CA')}
                </div>
              </div>
            </div>

            {/* ── Stats grid ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border">
              <Stat label="NAV"    value={`$${parseFloat(vault.nav).toFixed(4)}`}     accent="text-lime-400" />
              <Stat label="Buy"    value={`$${parseFloat(vault.buyPrice).toFixed(4)}`} accent="text-white" />
              <Stat label="TVL"    value={`$${parseFloat(vault.tvl).toFixed(2)}`}      accent="text-primary" />
              <Stat label="Volume" value={`$${parseFloat(vault.totalVolume).toFixed(2)}`} accent="text-amber-300" />
            </div>

            {/* ── On-chain accounts ── */}
            <div className="border border-border bg-surface p-6 space-y-3">
              <div className="text-xs font-mono text-primary uppercase tracking-widest mb-2">
                On-chain ({SOLANA_CONFIG.network})
              </div>
              <Row label="Vault PDA"   value={vault.core}    link={explorerAddress(vault.core)} />
              <Row label="Trading PDA" value={vault.trading} link={explorerAddress(vault.trading)} />
              <Row label="Leader"      value={vault.leader}  link={explorerAddress(vault.leader)} />
              {vault.metadataURI && <Row label="Metadata URI" value={vault.metadataURI} />}
            </div>
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="bg-black/60 p-4 text-center">
      <div className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">{label}</div>
      <div className={`text-lg font-mono font-bold ${accent}`}>{value}</div>
    </div>
  );
}

function Row({ label, value, link }: { label: string; value: string; link?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs font-mono">
      <span className="text-gray-500 uppercase tracking-widest text-[10px]">{label}</span>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline flex items-center gap-1.5 break-all text-right"
        >
          {shorten(value, 8, 6)}
          <ExternalLink size={11} className="shrink-0" />
        </a>
      ) : (
        <span className="text-gray-300 break-all text-right">{value}</span>
      )}
    </div>
  );
}

function SocialPill({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 px-3 py-1.5 border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary text-xs font-mono font-bold text-primary uppercase tracking-widest transition-colors"
    >
      {icon} {label}
    </a>
  );
}
