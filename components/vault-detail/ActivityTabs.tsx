'use client';

import { useEffect, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Loader2, ExternalLink } from 'lucide-react';
import { SOLANA_CONFIG } from '@/lib/contracts/config';
import { findVaultMintPda } from '@/lib/contracts/program';
import { explorerAddress } from './OnChainAccounts';
import type { VaultInfo } from '@/lib/vaults';

const connection = new Connection(SOLANA_CONFIG.rpcUrl, 'confirmed');

type VaultTab    = 'history' | 'holders' | 'trades';
type SubTab      = 'trades' | 'funding' | 'orders';

export default function ActivityTabs({
  vault,
  holders,
}: {
  vault: VaultInfo;
  holders: number | null;
}) {
  const [tab, setTab]       = useState<VaultTab>('trades');
  const [subTab, setSubTab] = useState<SubTab>('trades');

  return (
    <div className="border border-border bg-surface flex flex-col h-full">
      {/* Vault tab strip */}
      <div className="flex items-center gap-0 px-1 border-b border-border bg-black/40 overflow-x-auto">
        <span className="px-3 py-2 text-[10px] font-mono text-gray-600 uppercase tracking-widest">VAULT:</span>
        <TabBtn active={tab === 'history'} onClick={() => setTab('history')} label="History" />
        <TabBtn active={tab === 'holders'} onClick={() => setTab('holders')} label={`Holders${holders !== null ? ` (${holders})` : ''}`} />
        <TabBtn active={tab === 'trades'}  onClick={() => setTab('trades')}  label="Trades" />
        <span className="ml-auto px-3 py-2 text-[10px] font-mono text-gray-600 uppercase tracking-widest">L1:</span>
        <span className="px-3 py-2 text-[10px] font-mono text-gray-700 uppercase tracking-widest opacity-50 cursor-not-allowed">Assets</span>
        <span className="px-3 py-2 text-[10px] font-mono text-gray-700 uppercase tracking-widest opacity-50 cursor-not-allowed">Trades</span>
      </div>

      {/* Sub tab strip */}
      <div className="grid grid-cols-3 border-b border-border">
        <SubBtn active={subTab === 'trades'}  onClick={() => setSubTab('trades')}  label="Trades" />
        <SubBtn active={subTab === 'funding'} onClick={() => setSubTab('funding')} label="Funding" />
        <SubBtn active={subTab === 'orders'}  onClick={() => setSubTab('orders')}  label="Orders" />
      </div>

      {/* Body */}
      <div className="min-h-[180px]">
        {tab === 'holders' ? (
          <HoldersList vault={vault} />
        ) : tab === 'history' ? (
          <Empty msg="On-chain history will appear here once event indexing is wired up." />
        ) : (
          subTab === 'trades'  ? <Empty msg="No trade history yet — connect a Solana indexer or scan program logs to populate this." /> :
          subTab === 'funding' ? <Empty msg="Funding stream not applicable on Solana — Hyperliquid L1 perps only." /> :
                                 <Empty msg="Open orders not applicable for bonding-curve vault on Solana." />
        )}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-[11px] font-mono font-bold uppercase tracking-widest transition-colors ${
        active ? 'text-primary border-b-2 border-primary -mb-px' : 'text-gray-500 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

function SubBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`py-2 text-[11px] font-mono font-bold uppercase tracking-widest transition-colors ${
        active ? 'bg-primary/10 text-primary border-b-2 border-primary -mb-px' : 'text-gray-500 hover:text-white'
      }`}
    >
      {label}
    </button>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="flex items-center justify-center h-44 px-6 text-center">
      <div className="text-[11px] font-mono text-gray-600 leading-relaxed max-w-md">{msg}</div>
    </div>
  );
}

function HoldersList({ vault }: { vault: VaultInfo }) {
  const [rows, setRows] = useState<{ owner: string; amount: bigint }[] | null>(null);
  const [err, setErr]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [vaultMint] = findVaultMintPda(new PublicKey(vault.core));
        const accs = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
          commitment: 'confirmed',
          filters: [
            { dataSize: 165 },
            { memcmp: { offset: 0, bytes: vaultMint.toBase58() } },
          ],
        });
        if (cancelled) return;
        const decoded: { owner: string; amount: bigint }[] = [];
        for (const { account } of accs) {
          const buf = account.data as Buffer;
          const owner = new PublicKey(buf.subarray(32, 64)).toBase58();
          const amount = buf.readBigUInt64LE(64);
          if (amount > 0n) decoded.push({ owner, amount });
        }
        decoded.sort((a, b) => (a.amount < b.amount ? 1 : -1));
        setRows(decoded);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [vault.core]);

  if (err) {
    return <Empty msg={`Failed to load holders: ${err}`} />;
  }
  if (!rows) {
    return (
      <div className="flex items-center justify-center h-44 text-gray-500 font-mono text-xs">
        <Loader2 size={14} className="animate-spin mr-2" /> Loading holders…
      </div>
    );
  }
  if (rows.length === 0) {
    return <Empty msg="No holders yet." />;
  }
  const totalSupply = rows.reduce((sum, r) => sum + r.amount, 0n);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-[10px] text-gray-500 uppercase tracking-widest border-b border-border">
            <th className="text-left  py-2 px-4">#</th>
            <th className="text-left  py-2 px-4">Owner</th>
            <th className="text-right py-2 px-4">Balance</th>
            <th className="text-right py-2 px-4">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((r, i) => {
            const pct = Number(r.amount * 10000n / totalSupply) / 100;
            return (
              <tr key={r.owner} className="border-b border-border/60 hover:bg-primary/5">
                <td className="py-2 px-4 text-gray-500">{i + 1}</td>
                <td className="py-2 px-4">
                  <a
                    href={explorerAddress(r.owner)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1.5"
                  >
                    {r.owner.slice(0, 6)}…{r.owner.slice(-6)}
                    <ExternalLink size={10} />
                  </a>
                </td>
                <td className="py-2 px-4 text-right text-white">
                  {(Number(r.amount) / 1e9).toFixed(4)}
                </td>
                <td className="py-2 px-4 text-right text-gray-300">
                  {pct.toFixed(2)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
