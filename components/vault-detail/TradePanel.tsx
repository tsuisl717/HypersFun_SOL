'use client';

import { useEffect, useMemo, useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { ArrowDownUp, Loader2, ExternalLink, Globe } from 'lucide-react';

import { USDC_MINT } from '@/lib/contracts/config';
import {
  buildBuyIx,
  buildSellIx,
  prepareTradeAccounts,
  fetchVaultState,
  type VaultStateData,
} from '@/lib/contracts/program';
import {
  loadUserBalances,
  estimateBuyTokens,
  estimateSellUsdc,
  type UserBalances,
} from '@/lib/vault-trading';
import { explorerTx } from './OnChainAccounts';
import type { VaultInfo } from '@/lib/vaults';

type Side = 'buy' | 'sell';
const PERCENT_PRESETS = [10, 25, 50, 100] as const;

export default function TradePanel({
  vault,
  totalSupply,
  onTradeComplete,
}: {
  vault: VaultInfo;
  totalSupply: string | null;
  onTradeComplete?: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const vaultPk = useMemo(() => new PublicKey(vault.core), [vault.core]);

  const [side, setSide]       = useState<Side>('buy');
  const [amount, setAmount]   = useState('');
  const [balances, setBalances] = useState<UserBalances | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus]   = useState<{ kind: 'ok' | 'err' | 'info'; msg: string; sig?: string } | null>(null);
  const [vaultState, setVaultState] = useState<VaultStateData | null>(null);

  const refreshBalances = async () => {
    if (!publicKey) { setBalances(null); return; }
    try {
      setBalances(await loadUserBalances(connection, publicKey, vaultPk));
    } catch { setBalances(null); }
  };

  const refreshVaultState = async () => {
    try {
      const v = await fetchVaultState(connection, vaultPk);
      setVaultState(v);
    } catch { /* noop */ }
  };

  useEffect(() => { refreshBalances(); refreshVaultState(); }, [publicKey, vault.core]);

  const reserves = vaultState && { vBase: vaultState.virtualBase, vTokens: vaultState.virtualTokens };

  const preview = useMemo(() => {
    const n = parseFloat(amount);
    if (!n || !reserves || isNaN(n)) return null;
    if (side === 'buy') {
      const tokens = estimateBuyTokens(n, reserves.vBase, reserves.vTokens);
      return { label: `≈ ${tokens.toFixed(4)} ${vault.symbol}`, sub: `at ~$${(n / Math.max(tokens, 1e-9)).toFixed(4)}` };
    }
    const usdc = estimateSellUsdc(n, reserves.vBase, reserves.vTokens);
    return { label: `≈ $${usdc.toFixed(4)}`, sub: `at ~$${(usdc / Math.max(n, 1e-9)).toFixed(4)}` };
  }, [amount, reserves, side, vault.symbol]);

  const setPercent = (pct: number) => {
    if (!balances) return;
    const max = side === 'buy' ? parseFloat(balances.usdcBalance) : parseFloat(balances.vaultTokenBalance);
    setAmount(((max * pct) / 100).toFixed(side === 'buy' ? 2 : 4));
  };

  const onSubmit = async () => {
    if (!publicKey) return;
    const n = parseFloat(amount);
    if (!n || isNaN(n) || n <= 0) {
      setStatus({ kind: 'err', msg: 'Enter a valid amount.' });
      return;
    }
    setSubmitting(true);
    setStatus({ kind: 'info', msg: 'Building transaction…' });
    try {
      const accounts = await prepareTradeAccounts(connection, vaultPk, publicKey);
      const tx = new Transaction();
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        publicKey, accounts.userUsdcAccount, publicKey, USDC_MINT,
      ));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        publicKey, accounts.userVaultAccount, publicKey, accounts.vaultMint,
      ));
      if (side === 'buy') {
        tx.add(buildBuyIx(accounts, BigInt(Math.floor(n * 1_000_000))));
      } else {
        tx.add(buildSellIx(accounts, BigInt(Math.floor(n * 1_000_000_000))));
      }
      setStatus({ kind: 'info', msg: 'Awaiting wallet confirmation…' });
      const sig = await sendTransaction(tx, connection);
      setStatus({ kind: 'info', msg: 'Confirming…', sig });
      await connection.confirmTransaction(sig, 'confirmed');
      setStatus({ kind: 'ok', msg: side === 'buy' ? 'Buy successful!' : 'Sell successful!', sig });
      setAmount('');
      await Promise.all([refreshBalances(), refreshVaultState()]);
      onTradeComplete?.();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setStatus({ kind: 'err', msg: msg.includes('User rejected') ? 'Transaction rejected.' : msg });
    } finally {
      setSubmitting(false);
    }
  };

  const tvlNum   = parseFloat(vault.tvl) || 0;
  const navNum   = parseFloat(vault.nav) || 0;
  const supplyNum = totalSupply ? parseFloat(totalSupply) : 0;
  const rawNav   = vaultState && supplyNum > 0
    ? (Number(vaultState.virtualBase) / Number(vaultState.virtualTokens))
    : navNum;

  return (
    <div className="space-y-4">
      {/* Buy / Sell toggle */}
      <div className="border border-border bg-surface">
        <div className="grid grid-cols-2">
          <SideTab active={side === 'buy'}  onClick={() => { setSide('buy');  setAmount(''); setStatus(null); }} label="Buy"  color="lime" />
          <SideTab active={side === 'sell'} onClick={() => { setSide('sell'); setAmount(''); setStatus(null); }} label="Sell" color="rose" />
        </div>

        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest">
            <span className="text-gray-500">Amount</span>
            <span className="text-gray-500">
              Bal: <span className="text-gray-300">
                {balances ? (side === 'buy' ? balances.usdcBalance : balances.vaultTokenBalance) : '0.00'}
              </span>
            </span>
          </div>
          <div className="flex items-center bg-black border border-primary/20 focus-within:border-primary transition-colors">
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Min 5"
              className="flex-1 bg-transparent px-3 py-3 text-lg text-white font-mono focus:outline-none"
            />
            <span className="px-3 text-[11px] font-mono font-bold text-gray-500 uppercase tracking-widest">
              {side === 'buy' ? 'USDC' : vault.symbol}
            </span>
          </div>

          <div className="grid grid-cols-4 gap-px bg-border">
            {PERCENT_PRESETS.map((pct) => (
              <button
                key={pct}
                onClick={() => setPercent(pct)}
                disabled={!balances}
                className="py-2 bg-black/60 hover:bg-primary/10 disabled:opacity-40 text-[11px] font-mono font-bold text-gray-300 hover:text-primary uppercase tracking-widest transition-colors"
              >
                {pct}%
              </button>
            ))}
          </div>

          {preview && (
            <div className="border border-border bg-black/40 p-2.5 flex items-center gap-2.5 text-xs font-mono">
              <ArrowDownUp size={12} className="text-gray-500 shrink-0" />
              <div className="min-w-0">
                <div className="text-white font-bold truncate">{preview.label}</div>
                <div className="text-gray-500 text-[10px] truncate">{preview.sub}</div>
              </div>
            </div>
          )}

          {!connected ? (
            <WalletMultiButton style={{ width: '100%', justifyContent: 'center' }} />
          ) : (
            <button
              onClick={onSubmit}
              disabled={submitting || !amount}
              className={`w-full py-3 font-bold uppercase text-sm tracking-widest disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all ${
                side === 'buy'
                  ? 'bg-lime-500 text-black hover:bg-lime-400'
                  : 'bg-rose-500 text-white hover:bg-rose-400'
              }`}
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? 'Submitting…' : side === 'buy' ? 'Buy' : 'Sell'}
            </button>
          )}

          {status && (
            <div className={`p-2.5 text-[11px] font-mono break-all border ${
              status.kind === 'ok'  ? 'border-lime-500/40 bg-lime-500/5 text-lime-400' :
              status.kind === 'err' ? 'border-red-500/40 bg-red-500/5 text-red-400' :
                                      'border-primary/30 bg-primary/5 text-primary'
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
        </div>
      </div>

      {/* Reserve */}
      <Section title="Reserve">
        <div className="grid grid-cols-2 gap-px bg-border">
          <KV label="USDC Vault" value={`$${tvlNum.toFixed(2)}`} accent="text-cyan-300" />
          <KV label="Reserved"   value="$0.00"                    accent="text-gray-400" />
          <KV label="Fees"       value={vaultState ? `$${(Number(vaultState.protocolFee) / 1_000_000).toFixed(2)}` : '—'} accent="text-amber-300" />
          <KV label="Total"      value={`$${tvlNum.toFixed(2)}`}  accent="text-white" />
        </div>
      </Section>

      {/* Social */}
      {(vault.links?.website || vault.links?.twitter || vault.links?.telegram) && (
        <Section title="Social Links">
          <div className="flex items-center gap-2">
            {vault.links?.website && (
              <SocialBtn href={vault.links.website} icon={<Globe size={13} />} />
            )}
            {vault.links?.twitter && (
              <SocialBtn href={vault.links.twitter} icon={<span className="text-[11px] font-bold">𝕏</span>} />
            )}
            {vault.links?.telegram && (
              <SocialBtn href={vault.links.telegram} icon={<span className="text-[10px] font-bold">TG</span>} />
            )}
          </div>
        </Section>
      )}

      {/* NAV Stabilization */}
      <Section title="NAV Stabilization">
        <div className="grid grid-cols-2 gap-px bg-border">
          <KV label="Assets" value={`$${tvlNum.toFixed(0)}`}   accent="text-white" />
          <KV label="Supply" value={totalSupply ?? '—'}        accent="text-white" />
          <KV label="Raw NAV"  value={`$${rawNav.toFixed(4)}`} accent="text-amber-300" />
          <KV label="Stab NAV" value={`$${navNum.toFixed(4)}`} accent="text-amber-300" />
          <KV label="TWAP NAV" value={`$${navNum.toFixed(4)}`} accent="text-primary" full />
        </div>
      </Section>

      {/* Graduation tiers — placeholder until factory tier parser is exposed */}
      <Section
        title="Graduation Tiers"
        right={
          <span className="text-[10px] font-mono text-gray-600 uppercase tracking-widest">
            Tiers loading…
          </span>
        }
      >
        <div className="border border-border bg-black/40 p-3 text-[10px] font-mono text-gray-500 leading-relaxed">
          Tier table requires factory state parser extension. Add{' '}
          <code className="text-gray-400">graduation_tiers</code> decoding to{' '}
          <code className="text-gray-400">fetchFactoryState</code> in{' '}
          <code className="text-gray-400">lib/contracts/program.ts</code>.
        </div>
      </Section>
    </div>
  );
}

function Section({
  title, right, children,
}: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border border-border bg-surface">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="text-[10px] font-mono text-primary uppercase tracking-widest font-bold">
          {title}
        </div>
        {right}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function KV({
  label, value, accent, full,
}: { label: string; value: string; accent: string; full?: boolean }) {
  return (
    <div className={`bg-black/60 px-3 py-2.5 ${full ? 'col-span-2' : ''}`}>
      <div className="text-[9px] font-mono text-gray-500 uppercase tracking-widest mb-0.5">{label}</div>
      <div className={`font-mono text-sm font-bold ${accent}`}>{value}</div>
    </div>
  );
}

function SideTab({
  active, onClick, label, color,
}: { active: boolean; onClick: () => void; label: string; color: 'lime' | 'rose' }) {
  if (active) {
    return (
      <button onClick={onClick} className={`py-3 text-sm font-bold uppercase tracking-widest font-mono ${
        color === 'lime' ? 'bg-lime-500 text-black' : 'bg-rose-500 text-white'
      }`}>{label}</button>
    );
  }
  return (
    <button onClick={onClick} className="py-3 text-sm font-bold uppercase tracking-widest font-mono bg-black/60 text-gray-500 hover:text-white border-b border-border">
      {label}
    </button>
  );
}

function SocialBtn({ href, icon }: { href: string; icon: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-center w-9 h-9 border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary text-primary transition-colors"
    >
      {icon}
    </a>
  );
}
