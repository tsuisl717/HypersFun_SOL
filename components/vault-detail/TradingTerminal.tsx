'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { ArrowDownUp, Loader2, ExternalLink } from 'lucide-react';

import { USDC_MINT } from '@/lib/contracts/config';
import {
  buildBuyIx,
  buildSellIx,
  prepareTradeAccounts,
  fetchVaultState,
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

export default function TradingTerminal({
  vault,
  onTradeComplete,
}: {
  vault: VaultInfo;
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

  // Pull virtual reserves directly from on-chain VaultState for previews.
  const [reserves, setReserves] = useState<{ vBase: bigint; vTokens: bigint } | null>(null);

  const refreshBalances = async () => {
    if (!publicKey) { setBalances(null); return; }
    try {
      const b = await loadUserBalances(connection, publicKey, vaultPk);
      setBalances(b);
    } catch (e) {
      console.warn('loadUserBalances failed', e);
      setBalances(null);
    }
  };

  const refreshReserves = async () => {
    try {
      const v = await fetchVaultState(connection, vaultPk);
      if (v) setReserves({ vBase: v.virtualBase, vTokens: v.virtualTokens });
    } catch (e) {
      console.warn('fetchVaultState failed', e);
    }
  };

  useEffect(() => {
    refreshBalances();
    refreshReserves();
  }, [publicKey, vault.core]);

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

  const setMax = () => {
    if (!balances) return;
    setAmount(side === 'buy' ? balances.usdcBalance : balances.vaultTokenBalance);
  };

  const onSubmit = async () => {
    if (!publicKey) return;
    const n = parseFloat(amount);
    if (!n || isNaN(n) || n <= 0) {
      setStatus({ kind: 'err', msg: 'Enter a valid amount.' });
      return;
    }

    setSubmitting(true);
    setStatus({ kind: 'info', msg: side === 'buy' ? 'Building buy transaction…' : 'Building sell transaction…' });

    try {
      const accounts = await prepareTradeAccounts(connection, vaultPk, publicKey);

      const tx = new Transaction();

      // Ensure both ATAs exist (idempotent).
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        publicKey, accounts.userUsdcAccount, publicKey, USDC_MINT,
      ));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        publicKey, accounts.userVaultAccount, publicKey, accounts.vaultMint,
      ));

      if (side === 'buy') {
        const usdcAmountRaw = BigInt(Math.floor(n * 1_000_000)); // USDC 6 dec
        tx.add(buildBuyIx(accounts, usdcAmountRaw));
      } else {
        const tokenAmountRaw = BigInt(Math.floor(n * 1_000_000_000)); // 9 dec vault token
        tx.add(buildSellIx(accounts, tokenAmountRaw));
      }

      setStatus({ kind: 'info', msg: 'Awaiting wallet confirmation…' });
      const sig = await sendTransaction(tx, connection);
      setStatus({ kind: 'info', msg: 'Confirming…', sig });
      await connection.confirmTransaction(sig, 'confirmed');

      setStatus({ kind: 'ok', msg: side === 'buy' ? 'Buy successful!' : 'Sell successful!', sig });
      setAmount('');
      await Promise.all([refreshBalances(), refreshReserves()]);
      onTradeComplete?.();
    } catch (e: any) {
      console.error('trade failed', e);
      const msg = e?.message ?? String(e);
      setStatus({
        kind: 'err',
        msg: msg.includes('User rejected') ? 'Transaction rejected.' : msg,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border border-border bg-surface p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs font-mono text-primary uppercase tracking-widest">Trade</div>
        {connected && (
          <button
            onClick={() => { refreshBalances(); refreshReserves(); }}
            className="text-[10px] font-mono text-gray-500 hover:text-primary uppercase tracking-widest"
          >
            Refresh
          </button>
        )}
      </div>

      {/* Side toggle */}
      <div className="grid grid-cols-2 gap-px bg-border">
        <SideButton active={side === 'buy'}  onClick={() => { setSide('buy');  setAmount(''); setStatus(null); }} label="Buy"  color="lime"  />
        <SideButton active={side === 'sell'} onClick={() => { setSide('sell'); setAmount(''); setStatus(null); }} label="Sell" color="rose" />
      </div>

      {/* Amount input */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">
            {side === 'buy' ? 'Amount (USDC)' : `Amount (${vault.symbol})`}
          </label>
          {balances && (
            <button
              onClick={setMax}
              className="text-[10px] font-mono text-primary hover:underline uppercase tracking-widest"
            >
              Max {side === 'buy' ? balances.usdcBalance : balances.vaultTokenBalance}
            </button>
          )}
        </div>
        <input
          type="number"
          inputMode="decimal"
          step="any"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className="w-full bg-black border border-primary/20 px-3 py-3 text-lg text-white font-mono focus:outline-none focus:border-primary transition-colors"
        />
      </div>

      {/* Preview */}
      {preview && (
        <div className="border border-border bg-black/40 p-3 flex items-center gap-3 text-xs font-mono">
          <ArrowDownUp size={14} className="text-gray-500" />
          <div>
            <div className="text-white font-bold">{preview.label}</div>
            <div className="text-gray-500 text-[10px]">{preview.sub}</div>
          </div>
        </div>
      )}

      {/* Action */}
      {!connected ? (
        <WalletMultiButton style={{ width: '100%', justifyContent: 'center' }} />
      ) : (
        <button
          onClick={onSubmit}
          disabled={submitting || !amount}
          className={`w-full py-3 font-bold uppercase text-xs tracking-widest disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all ${
            side === 'buy'
              ? 'bg-lime-500 text-black hover:bg-lime-400'
              : 'bg-rose-500 text-white hover:bg-rose-400'
          }`}
        >
          {submitting && <Loader2 size={14} className="animate-spin" />}
          {submitting ? 'Submitting…' : side === 'buy' ? `Buy ${vault.symbol}` : `Sell ${vault.symbol}`}
        </button>
      )}

      {status && (
        <div className={`p-3 text-[11px] font-mono break-all border ${
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

      {/* Tiny note about instruction names */}
      <div className="text-[10px] font-mono text-gray-600 leading-relaxed">
        Calls program instructions <code className="text-gray-400">buy</code> /{' '}
        <code className="text-gray-400">sell</code>. If your deployed program uses
        different names, edit{' '}
        <code className="text-gray-400">lib/contracts/program.ts</code>.
      </div>
    </div>
  );
}

function SideButton({
  active, onClick, label, color,
}: {
  active: boolean; onClick: () => void; label: string; color: 'lime' | 'rose';
}) {
  const base = 'py-2 text-xs font-bold uppercase tracking-widest font-mono transition-colors';
  if (active) {
    return (
      <button onClick={onClick} className={`${base} ${
        color === 'lime' ? 'bg-lime-500/15 text-lime-400 border-b-2 border-lime-500'
                         : 'bg-rose-500/15 text-rose-400 border-b-2 border-rose-500'
      }`}>{label}</button>
    );
  }
  return (
    <button onClick={onClick} className={`${base} bg-black/40 text-gray-500 hover:text-white`}>
      {label}
    </button>
  );
}
