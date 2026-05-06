'use client';

import { ExternalLink } from 'lucide-react';
import { SOLANA_CONFIG } from '@/lib/contracts/config';
import type { VaultInfo } from '@/lib/vaults';

const EXPLORER_BASE = 'https://explorer.solana.com';
const cluster = SOLANA_CONFIG.network === 'mainnet' ? '' : `?cluster=${SOLANA_CONFIG.network}`;
export const explorerAddress = (addr: string) => `${EXPLORER_BASE}/address/${addr}${cluster}`;
export const explorerTx = (sig: string) => `${EXPLORER_BASE}/tx/${sig}${cluster}`;

const shorten = (s: string, head = 8, tail = 6) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;

export default function OnChainAccounts({ vault }: { vault: VaultInfo }) {
  return (
    <div className="border border-border bg-surface p-6 space-y-3">
      <div className="text-xs font-mono text-primary uppercase tracking-widest mb-2">
        On-chain ({SOLANA_CONFIG.network})
      </div>
      <Row label="Vault PDA"   value={vault.core}    link={explorerAddress(vault.core)} />
      <Row label="Trading PDA" value={vault.trading} link={explorerAddress(vault.trading)} />
      <Row label="Leader"      value={vault.leader}  link={explorerAddress(vault.leader)} />
      {vault.metadataURI && <Row label="Metadata URI" value={vault.metadataURI} />}
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
