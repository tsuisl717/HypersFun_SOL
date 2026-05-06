'use client';

import { useEffect, useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Loader2, Pause, Play, Pencil, ShieldCheck, ExternalLink } from 'lucide-react';

import {
  buildSetPausedIx,
  buildSetMetadataUriIx,
  buildSetVerifiedIx,
  findFactoryPda,
  fetchVaultState,
  fetchFactoryState,
} from '@/lib/contracts/program';
import { explorerTx } from './OnChainAccounts';
import type { VaultInfo } from '@/lib/vaults';

type Role = 'admin' | 'leader' | 'authority' | null;

export default function AdminPanel({
  vault,
  onChange,
}: {
  vault: VaultInfo;
  onChange?: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [paused, setPaused]         = useState<boolean | null>(null);
  const [admin, setAdmin]           = useState<string | null>(null);
  const [authority, setAuthority]   = useState<string | null>(null);
  const [role, setRole]             = useState<Role>(null);

  const [newUri, setNewUri]         = useState(vault.metadataURI || '');
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [status, setStatus]         = useState<{ kind: 'ok' | 'err'; msg: string; sig?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await fetchVaultState(connection, new PublicKey(vault.core));
        if (cancelled) return;
        if (v) {
          setPaused(v.paused);
          setAdmin(v.admin.toBase58());
          if (publicKey) {
            if (v.admin.equals(publicKey))  { setRole('admin'); return; }
            if (v.leader.equals(publicKey)) { setRole('leader'); return; }
          }
        }
        const f = await fetchFactoryState(connection);
        if (cancelled) return;
        if (f) {
          setAuthority(f.authority.toBase58());
          if (publicKey && f.authority.equals(publicKey)) { setRole('authority'); return; }
        }
        setRole(null);
      } catch (e) {
        console.warn('AdminPanel detect role failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, publicKey, vault.core]);

  const send = async (label: string, build: () => Transaction) => {
    if (!publicKey) return;
    setSubmitting(label);
    setStatus(null);
    try {
      const tx = build();
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      setStatus({ kind: 'ok', msg: `${label} succeeded`, sig });
      onChange?.();
      // refresh paused state
      const v = await fetchVaultState(connection, new PublicKey(vault.core));
      if (v) setPaused(v.paused);
    } catch (e: any) {
      console.error(`${label} failed`, e);
      setStatus({ kind: 'err', msg: e?.message ?? String(e) });
    } finally {
      setSubmitting(null);
    }
  };

  if (!connected) {
    return (
      <div className="border border-border bg-surface p-6 text-xs font-mono text-gray-500">
        Connect a wallet to view admin tools.
      </div>
    );
  }

  if (role === null) {
    return (
      <div className="border border-border bg-surface p-6 space-y-2 text-xs font-mono">
        <div className="text-gray-500 uppercase tracking-widest">Admin</div>
        <div className="text-gray-400">
          You are not the admin, leader, or factory authority for this vault.
        </div>
        {admin     && <div className="text-gray-600">Admin: <span className="text-gray-400">{admin}</span></div>}
        {authority && <div className="text-gray-600">Factory authority: <span className="text-gray-400">{authority}</span></div>}
      </div>
    );
  }

  const canPause    = role === 'admin' || role === 'leader';
  const canSetUri   = role === 'leader';
  const canVerify   = role === 'authority';

  return (
    <div className="border border-border bg-surface p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-xs font-mono text-primary uppercase tracking-widest">
          Admin · {role}
        </div>
        {paused !== null && (
          <span className={`px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-widest ${
            paused ? 'bg-red-500/15 text-red-400 border border-red-500/40'
                   : 'bg-lime-500/15 text-lime-400 border border-lime-500/40'
          }`}>
            {paused ? 'Paused' : 'Active'}
          </span>
        )}
      </div>

      {/* Pause / Resume */}
      {canPause && paused !== null && (
        <Section title="Trading">
          <button
            disabled={!!submitting}
            onClick={() => send(paused ? 'Resume vault' : 'Pause vault', () => {
              return new Transaction().add(buildSetPausedIx(publicKey!, new PublicKey(vault.core), !paused));
            })}
            className="w-full py-2.5 border border-border hover:border-primary/60 bg-black/40 text-xs font-mono font-bold uppercase tracking-widest text-white flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {submitting?.startsWith('Pause') || submitting?.startsWith('Resume')
              ? <Loader2 size={12} className="animate-spin" />
              : (paused ? <Play size={12} /> : <Pause size={12} />)}
            {paused ? 'Resume vault' : 'Pause vault'}
          </button>
        </Section>
      )}

      {/* Metadata URI */}
      {canSetUri && (
        <Section title="Metadata URI">
          <input
            value={newUri}
            onChange={(e) => setNewUri(e.target.value)}
            placeholder="ipfs://… or https://…"
            className="w-full bg-black border border-primary/20 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-primary"
          />
          <button
            disabled={!!submitting || !newUri.trim() || newUri === vault.metadataURI}
            onClick={() => send('Update metadata URI', () => {
              return new Transaction().add(buildSetMetadataUriIx(
                { leader: publicKey!, vaultState: new PublicKey(vault.core) },
                newUri.trim(),
              ));
            })}
            className="w-full mt-2 py-2.5 bg-primary text-black text-xs font-mono font-bold uppercase tracking-widest hover:bg-primary/80 flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {submitting === 'Update metadata URI'
              ? <Loader2 size={12} className="animate-spin" />
              : <Pencil size={12} />}
            Update URI
          </button>
        </Section>
      )}

      {/* Verify (factory authority only) */}
      {canVerify && (
        <Section title="Verification">
          <div className="flex gap-2">
            <button
              disabled={!!submitting || vault.verified}
              onClick={() => send('Mark verified', () => {
                const [factoryPda] = findFactoryPda();
                return new Transaction().add(buildSetVerifiedIx(
                  publicKey!, factoryPda, new PublicKey(vault.core), true,
                ));
              })}
              className="flex-1 py-2.5 border border-lime-500/40 bg-lime-500/10 hover:bg-lime-500/20 text-xs font-mono font-bold uppercase tracking-widest text-lime-400 flex items-center justify-center gap-2 disabled:opacity-40"
            >
              <ShieldCheck size={12} /> Verify
            </button>
            <button
              disabled={!!submitting || !vault.verified}
              onClick={() => send('Unverify', () => {
                const [factoryPda] = findFactoryPda();
                return new Transaction().add(buildSetVerifiedIx(
                  publicKey!, factoryPda, new PublicKey(vault.core), false,
                ));
              })}
              className="flex-1 py-2.5 border border-border hover:border-red-500/60 bg-black/40 text-xs font-mono font-bold uppercase tracking-widest text-gray-300 flex items-center justify-center gap-2 disabled:opacity-40"
            >
              Unverify
            </button>
          </div>
        </Section>
      )}

      {status && (
        <div className={`p-3 text-[11px] font-mono break-all border ${
          status.kind === 'ok' ? 'border-lime-500/40 bg-lime-500/5 text-lime-400'
                               : 'border-red-500/40 bg-red-500/5 text-red-400'
        }`}>
          <div>{status.msg}</div>
          {status.sig && (
            <a
              href={explorerTx(status.sig)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 mt-1 underline hover:opacity-80"
            >
              View tx <ExternalLink size={10} />
            </a>
          )}
        </div>
      )}

      <div className="text-[10px] font-mono text-gray-600 leading-relaxed">
        Calls <code className="text-gray-400">set_paused</code>,{' '}
        <code className="text-gray-400">set_metadata_uri</code>,{' '}
        <code className="text-gray-400">set_verified</code>.
        Adjust discriminators in <code className="text-gray-400">lib/contracts/program.ts</code> if your program differs.
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">{title}</div>
      {children}
    </div>
  );
}
