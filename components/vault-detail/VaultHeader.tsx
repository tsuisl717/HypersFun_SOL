'use client';

import Image from 'next/image';
import { useState } from 'react';
import { ShieldCheck, Globe, Send } from 'lucide-react';
import type { VaultInfo } from '@/lib/vaults';

export default function VaultHeader({ vault }: { vault: VaultInfo }) {
  const [imgErr, setImgErr] = useState(false);

  return (
    <div className="border border-border bg-surface flex flex-col md:flex-row overflow-hidden">
      <div className="relative w-full md:w-72 h-72 md:h-auto bg-black border-b md:border-b-0 md:border-r border-border shrink-0">
        {vault.imageUrl && !imgErr ? (
          vault.imageUrl.startsWith('data:') ? (
            // eslint-disable-next-line @next/next/no-img-element
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
