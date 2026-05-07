'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Copy, Check, Droplet, ExternalLink, Loader2, Wallet } from 'lucide-react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import Broadcast from '@/components/Broadcast';
import { NETWORK, USDC_MINT, USDC_DECIMALS } from '@/lib/contracts/config';

const SOL_AIRDROP_AMOUNT = 1; // SOL per request
const SOL_FAUCET_FALLBACK = 'https://faucet.solana.com/';

// Drift devnet faucet program — mints 5,000 tUSDC per claim into the caller's ATA
const FAUCET_PROGRAM = new PublicKey('V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB');
const FAUCET_CONFIG  = new PublicKey('A5pgLYFVj2oNeZX3Bqi8jCnxNkLPzUNJCnNVisqcuth7');
const MINT_AUTHORITY = new PublicKey('DgqYwE7MdWhTFWwN1heNsbuZE5AxxzozQvNFe6tpJFqB');
// MintToUser discriminator + 5_000_000_000 (5,000 USDC, 6 decimals) as little-endian u64
const MINT_TO_USER_DATA = Buffer.from([
  75, 194, 44, 77, 10, 65, 232, 85,
  0, 242, 5, 42, 1, 0, 0, 0,
]);
const USDC_CLAIM_AMOUNT = 5000;

export default function FaucetPage() {
  const router = useRouter();
  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction } = useWallet();

  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [airdropLoading, setAirdropLoading] = useState(false);
  const [airdropStatus, setAirdropStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [usdcLoading, setUsdcLoading] = useState(false);
  const [usdcStatus, setUsdcStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const isDevnet = NETWORK === 'devnet';

  const loadBalances = useCallback(async () => {
    if (!publicKey) {
      setSolBalance(null);
      setUsdcBalance(null);
      return;
    }
    setRefreshing(true);
    try {
      const lamports = await connection.getBalance(publicKey, 'confirmed');
      setSolBalance(lamports / LAMPORTS_PER_SOL);
    } catch {
      setSolBalance(null);
    }
    try {
      const ata = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), publicKey, true);
      const acc = await getAccount(connection, ata, 'confirmed');
      setUsdcBalance(Number(acc.amount) / Math.pow(10, USDC_DECIMALS));
    } catch (e) {
      if (e instanceof TokenAccountNotFoundError) setUsdcBalance(0);
      else setUsdcBalance(null);
    }
    setRefreshing(false);
  }, [connection, publicKey]);

  useEffect(() => { loadBalances(); }, [loadBalances]);

  const handleAirdrop = async () => {
    if (!publicKey || !isDevnet) return;
    setAirdropLoading(true);
    setAirdropStatus(null);
    try {
      const sig = await connection.requestAirdrop(publicKey, SOL_AIRDROP_AMOUNT * LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction(
        { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        'confirmed',
      );
      setAirdropStatus({ kind: 'ok', msg: `Sent ${SOL_AIRDROP_AMOUNT} SOL — ${sig.slice(0, 16)}...` });
      loadBalances();
    } catch (e: unknown) {
      const msg = (e as { message?: string }).message ?? 'Airdrop failed';
      setAirdropStatus({
        kind: 'err',
        msg: msg.includes('429') || msg.toLowerCase().includes('rate')
          ? 'RPC rate limit hit. Try the external faucet below.'
          : msg.slice(0, 160),
      });
    } finally {
      setAirdropLoading(false);
    }
  };

  const handleClaimUsdc = async () => {
    if (!publicKey || !sendTransaction || !isDevnet) return;
    setUsdcLoading(true);
    setUsdcStatus(null);
    try {
      const usdcMint = new PublicKey(USDC_MINT);
      const userAta = await getAssociatedTokenAddress(usdcMint, publicKey);

      const tx = new Transaction();

      const ataInfo = await connection.getAccountInfo(userAta);
      if (!ataInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            publicKey,
            userAta,
            publicKey,
            usdcMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      }

      tx.add(
        new TransactionInstruction({
          programId: FAUCET_PROGRAM,
          keys: [
            { pubkey: FAUCET_CONFIG,    isSigner: false, isWritable: false },
            { pubkey: usdcMint,         isSigner: false, isWritable: true  },
            { pubkey: userAta,          isSigner: false, isWritable: true  },
            { pubkey: MINT_AUTHORITY,   isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: MINT_TO_USER_DATA,
        }),
      );

      const latest = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = latest.blockhash;
      tx.feePayer = publicKey;

      const sig = await sendTransaction(tx, connection, { skipPreflight: false });
      await connection.confirmTransaction(
        { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        'confirmed',
      );
      setUsdcStatus({ kind: 'ok', msg: `Claimed ${USDC_CLAIM_AMOUNT.toLocaleString()} tUSDC — ${sig.slice(0, 16)}...` });
      loadBalances();
    } catch (e: unknown) {
      const msg = (e as { message?: string }).message ?? 'Claim failed';
      setUsdcStatus({ kind: 'err', msg: msg.slice(0, 200) });
    } finally {
      setUsdcLoading(false);
    }
  };

  const copy = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch { /* clipboard blocked */ }
  };

  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Broadcast />
      <Header searchQuery="" onSearchChange={() => {}} onLogoClick={() => router.push('/')} />

      <main className="flex-1 flex flex-col">
        {/* Sub-header */}
        <div className="border-b border-border px-4 py-3 flex items-center">
          <Link href="/" className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors">
            <ArrowLeft size={16} />
            <span className="text-sm font-bold uppercase tracking-widest">Back</span>
          </Link>
        </div>

        <div className="flex-1 px-4 py-8 md:py-12">
          <div className="w-full max-w-2xl mx-auto space-y-6">
            {/* Title */}
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Droplet size={20} className="text-primary" />
                <h1 className="text-xl md:text-2xl font-black uppercase tracking-widest">Faucet</h1>
                <span className={`text-[10px] font-mono font-bold uppercase tracking-widest px-2 py-0.5 border ${
                  isDevnet ? 'border-primary/40 text-primary bg-primary/10' : 'border-yellow-500/40 text-yellow-400 bg-yellow-500/10'
                }`}>
                  {NETWORK}
                </span>
              </div>
              <p className="text-xs md:text-sm font-mono text-gray-400">
                Get devnet test tokens to try out HypersFun without spending real assets.
              </p>
            </div>

            {/* Mainnet warning */}
            {!isDevnet && (
              <div className="border border-yellow-500/30 bg-yellow-500/5 p-4 text-xs text-yellow-300 font-mono">
                Faucets only work on devnet. The current network is{' '}
                <span className="font-bold uppercase">{NETWORK}</span>. Switch your env to devnet to claim test tokens.
              </div>
            )}

            {/* Wallet / Balances */}
            <div className="border border-border bg-white/[0.02] p-4 md:p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                  <Wallet size={12} className="text-primary" />
                  Your Wallet
                </div>
                {connected && (
                  <button
                    onClick={loadBalances}
                    disabled={refreshing}
                    className="text-[10px] font-bold uppercase tracking-widest text-gray-400 hover:text-primary transition-colors disabled:opacity-50"
                  >
                    {refreshing ? 'Refreshing...' : 'Refresh'}
                  </button>
                )}
              </div>

              {!connected || !publicKey ? (
                <div className="flex flex-col items-center gap-3 py-4">
                  <p className="text-xs font-mono text-gray-500">Connect your wallet to claim test tokens.</p>
                  <WalletMultiButton />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-gray-500 uppercase tracking-widest">Address</span>
                    <button
                      onClick={() => copy(publicKey.toBase58(), 'addr')}
                      className="flex items-center gap-2 text-white hover:text-primary transition-colors"
                    >
                      <span>{publicKey.toBase58().slice(0, 6)}...{publicKey.toBase58().slice(-6)}</span>
                      {copiedField === 'addr' ? <Check size={12} className="text-primary" /> : <Copy size={12} />}
                    </button>
                  </div>
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-gray-500 uppercase tracking-widest">SOL</span>
                    <span className="text-white font-bold">
                      {solBalance === null ? '—' : `${solBalance.toFixed(4)} SOL`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-gray-500 uppercase tracking-widest">USDC</span>
                    <span className="text-white font-bold">
                      {usdcBalance === null ? '—' : `${usdcBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* SOL Faucet */}
            <div className="border border-border bg-white/[0.02] p-4 md:p-5 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-black uppercase tracking-widest text-white">Devnet SOL</h2>
                  <p className="text-[11px] font-mono text-gray-500 mt-1">
                    Pays for transaction fees. {SOL_AIRDROP_AMOUNT} SOL per request, RPC-rate-limited.
                  </p>
                </div>
                <span className="text-[10px] font-mono font-bold text-primary uppercase tracking-widest shrink-0">
                  +{SOL_AIRDROP_AMOUNT} SOL
                </span>
              </div>

              <button
                onClick={handleAirdrop}
                disabled={!connected || !isDevnet || airdropLoading}
                className="w-full py-3 font-black uppercase tracking-widest text-sm bg-primary text-black hover:brightness-110 active:scale-[0.99] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {airdropLoading && <Loader2 size={14} className="animate-spin" />}
                {airdropLoading ? 'Requesting...' : `Request ${SOL_AIRDROP_AMOUNT} SOL`}
              </button>

              {airdropStatus && (
                <div className={`text-xs font-mono px-3 py-2 border ${
                  airdropStatus.kind === 'ok'
                    ? 'border-primary/30 text-primary bg-primary/10'
                    : 'border-red-500/30 text-red-400 bg-red-500/10'
                }`}>
                  {airdropStatus.msg}
                </div>
              )}

              <a
                href={SOL_FAUCET_FALLBACK}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 text-[11px] font-bold uppercase tracking-widest text-gray-400 hover:text-primary transition-colors"
              >
                External faucet (if rate-limited) <ExternalLink size={11} />
              </a>
            </div>

            {/* USDC Faucet */}
            <div className="border border-border bg-white/[0.02] p-4 md:p-5 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-black uppercase tracking-widest text-white">Devnet tUSDC</h2>
                  <p className="text-[11px] font-mono text-gray-500 mt-1">
                    Drift devnet faucet — mints test USDC straight to your wallet. Used to buy and sell vault tokens.
                  </p>
                </div>
                <span className="text-[10px] font-mono font-bold text-primary uppercase tracking-widest shrink-0">
                  +{USDC_CLAIM_AMOUNT.toLocaleString()} tUSDC
                </span>
              </div>

              <div className="border border-border bg-black/40 p-3 space-y-2">
                <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Mint Address</div>
                <button
                  onClick={() => copy(USDC_MINT, 'usdc-mint')}
                  className="w-full flex items-center justify-between gap-2 text-[11px] font-mono text-white hover:text-primary transition-colors break-all text-left"
                >
                  <span className="truncate">{USDC_MINT}</span>
                  {copiedField === 'usdc-mint'
                    ? <Check size={12} className="text-primary shrink-0" />
                    : <Copy size={12} className="shrink-0" />}
                </button>
              </div>

              <button
                onClick={handleClaimUsdc}
                disabled={!connected || !isDevnet || usdcLoading}
                className="w-full py-3 font-black uppercase tracking-widest text-sm bg-primary text-black hover:brightness-110 active:scale-[0.99] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {usdcLoading && <Loader2 size={14} className="animate-spin" />}
                {usdcLoading ? 'Claiming...' : `Claim ${USDC_CLAIM_AMOUNT.toLocaleString()} tUSDC`}
              </button>

              {usdcStatus && (
                <div className={`text-xs font-mono px-3 py-2 border break-all ${
                  usdcStatus.kind === 'ok'
                    ? 'border-primary/30 text-primary bg-primary/10'
                    : 'border-red-500/30 text-red-400 bg-red-500/10'
                }`}>
                  {usdcStatus.msg}
                </div>
              )}
            </div>

            <p className="text-center text-[10px] font-mono text-gray-600 uppercase tracking-widest pt-2">
              Test tokens have no real-world value.
            </p>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
