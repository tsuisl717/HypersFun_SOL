'use client';

import { useState, useEffect, use, useCallback } from 'react';
import Link from 'next/link';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import * as anchor from '@coral-xyz/anchor';
import dynamic from 'next/dynamic';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { getExplorerUrl, PROGRAM_ID, USDC_MINT } from '@/lib/contracts/config';
import {
  getUsdcVaultPda,
  getUserSharePda,
  getProgram,
} from '@/lib/contracts/margin';

// Mirror of Rust get_effective_virtuals — all math uses BigInt to avoid
// JS precision loss (intermediate products can reach ~1e22, beyond safe integer).
const TIER_SEED_THRESHOLD_BI      = 100_000_000_000n;     // $100K in µ
const TIER_GROWTH_THRESHOLD_BI    = 1_000_000_000_000n;   // $1M
const TIER_MATURE_THRESHOLD_BI    = 10_000_000_000_000n;  // $10M
const TIER_GRADUATED_THRESHOLD_BI = 100_000_000_000_000n; // $100M
// EVM-aligned tier BC depths (µ units, 6 decimals)
const TIER_SEED_BC_BI             = 500_000_000_000n;
const TIER_GROWTH_BC_BI           = 5_000_000_000_000n;
const TIER_MATURE_BC_BI           = 10_000_000_000_000n;
const TIER_GRADUATED_BC_BI        = 100_000_000_000_000n;
const DEFAULT_BC_BI               = 2_000_000_000_000n; // 2M (EVM default)
const BC_PRECISION_BI             = 1_000_000n;
const BPS_BI                      = 10_000n;
// Squared ratio weights per tier (EVM V38)
const SEED_SQ_BPS_BI              = 9_000n;  // 90%
const GROWTH_SQ_BPS_BI            = 6_000n;  // 60%
const MATURE_SQ_BPS_BI            = 1_500n;  // 15%
const GRADUATED_SQ_BPS_BI         = 200n;    // 2%
// Hard cap: effective ratio ≤ 5×
const HARD_CAP_EFF_RATIO_BPS_BI   = 50_000n;

function getTierBC(totalAssetsMu: bigint): bigint {
  if (totalAssetsMu >= TIER_GRADUATED_THRESHOLD_BI) return TIER_GRADUATED_BC_BI;
  if (totalAssetsMu >= TIER_MATURE_THRESHOLD_BI)    return TIER_MATURE_BC_BI;
  if (totalAssetsMu >= TIER_GROWTH_THRESHOLD_BI)    return TIER_GROWTH_BC_BI;
  if (totalAssetsMu >= TIER_SEED_THRESHOLD_BI)      return TIER_SEED_BC_BI;
  return DEFAULT_BC_BI;
}

function getSquaredRatioBps(mu: bigint): bigint {
  if (mu >= TIER_GRADUATED_THRESHOLD_BI) return GRADUATED_SQ_BPS_BI;
  if (mu >= TIER_MATURE_THRESHOLD_BI)    return MATURE_SQ_BPS_BI;
  if (mu >= TIER_GROWTH_THRESHOLD_BI)    return GROWTH_SQ_BPS_BI;
  return SEED_SQ_BPS_BI; // Seed and below = 90%
}

function getEffectiveVirtuals(totalAssetsUsd: number, vBase: number, vTokens: number) {
  const mu = BigInt(Math.floor(totalAssetsUsd * 1e6));
  const tierBC = getTierBC(mu);
  if (vBase <= 0 || vTokens <= 0) return { effBase: tierBC, effTokens: tierBC };
  const vBaseBI   = BigInt(Math.floor(vBase));
  const vTokensBI = BigInt(Math.floor(vTokens));

  const sqBps = getSquaredRatioBps(mu);

  let effBase = (tierBC * vBaseBI) / vTokensBI;

  const squaredPart = (tierBC * vTokensBI) / vBaseBI;
  const linearPart  = tierBC;
  let effTokens: bigint;
  if (sqBps >= BPS_BI) {
    effTokens = squaredPart;
  } else if (sqBps === 0n) {
    effTokens = linearPart;
  } else {
    effTokens = (squaredPart * sqBps + linearPart * (BPS_BI - sqBps)) / BPS_BI;
  }

  effBase   = effBase   < 1n ? 1n : effBase;
  effTokens = effTokens < 1n ? 1n : effTokens;

  const ratioBps = (effBase * BPS_BI) / effTokens;
  if (ratioBps > HARD_CAP_EFF_RATIO_BPS_BI) {
    effTokens = (effBase * BPS_BI) / HARD_CAP_EFF_RATIO_BPS_BI;
    if (effTokens < 1n) effTokens = 1n;
  }
  return { effBase, effTokens };
}

function getVbUsdc(effBase: bigint, navPrecision: number): bigint {
  return (effBase * BigInt(navPrecision)) / BC_PRECISION_BI;
}

function bcBuyPrice(vbUsdc: bigint, effTokens: bigint, usdcInMu: number) {
  const usdcIn = BigInt(Math.floor(usdcInMu));
  if (usdcIn <= 0n || effTokens <= 0n || vbUsdc <= 0n) return { tokensOut: 0, price: 0 };
  const tokensOut = (effTokens * usdcIn) / (vbUsdc + usdcIn);
  const price = tokensOut > 0n ? Number(usdcIn) / Number(tokensOut) : 0;
  return { tokensOut: Number(tokensOut), price };
}

function bcSellPrice(vbUsdc: bigint, effTokens: bigint, tokensInMu: number): number {
  const tokensIn = BigInt(Math.floor(tokensInMu));
  if (tokensIn <= 0n || effTokens <= 0n || vbUsdc <= 0n) return 0;
  return Number((vbUsdc * tokensIn) / (effTokens + tokensIn));
}

const PriceChart = dynamic(
  () => import('@/components/bonding-curve-vault/PriceChart'),
  { ssr: false, loading: () => <div className="bg-[#131722] h-full flex items-center justify-center"><div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" /></div> }
);
const MarginTradingPanel = dynamic(
  () => import('@/components/bonding-curve-vault/MarginTradingPanel'),
  { ssr: false }
);

interface VaultOnChain {
  address: string;
  leader: string;
  name: string;
  symbol: string;
  tokenMint: string;
  usdcReserve: number;
  externalAssets: number;
  totalSupply: number;
  performanceFeeBps: number;
  isPaused: boolean;
  nav: number;
  bcVirtualBase: number;
  bcVirtualTokens: number;
}

async function fetchVaultOnChain(
  vaultAddress: string,
  provider: anchor.AnchorProvider
): Promise<VaultOnChain | null> {
  try {
    const program = getProgram(provider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc: any = await (program.account as any).vault.fetch(new PublicKey(vaultAddress));
    const usdcReserve = acc.usdcReserve.toNumber() / 1e6;
    const externalAssets = acc.externalAssets.toNumber() / 1e6;
    const totalSupply = acc.totalSupply.toNumber() / 1e6;
    const totalAssets = usdcReserve + externalAssets;
    const nav = totalSupply > 0 ? totalAssets / totalSupply : 1;
    return {
      address: vaultAddress,
      leader: acc.leader.toBase58(),
      name: acc.name,
      symbol: acc.symbol,
      tokenMint: acc.tokenMint.toBase58(),
      usdcReserve,
      externalAssets,
      totalSupply,
      performanceFeeBps: acc.performanceFeeBps,
      isPaused: acc.isPaused,
      nav,
      bcVirtualBase:   acc.bcVirtualBase.toNumber(),
      bcVirtualTokens: acc.bcVirtualTokens.toNumber(),
    };
  } catch {
    return null;
  }
}

export default function VaultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: vaultAddress } = use(params);
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();

  const [vault, setVault] = useState<VaultOnChain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'trading' | 'leader'>('trading');

  const [buyAmount, setBuyAmount] = useState('');
  const [sellAmount, setSellAmount] = useState('');
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [txLoading, setTxLoading] = useState(false);

  const [userUsdc, setUserUsdc] = useState<number | null>(null);
  const [userTokens, setUserTokens] = useState<number | null>(null);

  function getProvider(): anchor.AnchorProvider {
    if (!publicKey || !signTransaction || !signAllTransactions) {
      return new anchor.AnchorProvider(
        connection,
        {
          publicKey: PublicKey.default,
          signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
          signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs,
        },
        { commitment: 'confirmed' }
      );
    }
    return new anchor.AnchorProvider(
      connection,
      { publicKey, signTransaction, signAllTransactions },
      { commitment: 'confirmed' }
    );
  }

  const loadVault = useCallback(async () => {
    setLoading(true);
    setError(null);
    const provider = getProvider();
    const data = await fetchVaultOnChain(vaultAddress, provider);
    if (data) setVault(data);
    else setError('Vault not found on-chain.');
    setLoading(false);
  }, [vaultAddress, connection]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadUserBalances = useCallback(async () => {
    if (!publicKey || !vault) return;
    try {
      const [usdcAta, tokenAta] = await Promise.all([
        getAssociatedTokenAddress(new PublicKey(USDC_MINT), publicKey),
        getAssociatedTokenAddress(new PublicKey(vault.tokenMint), publicKey),
      ]);
      const [usdcAcc, tokenAcc] = await Promise.allSettled([
        getAccount(connection, usdcAta),
        getAccount(connection, tokenAta),
      ]);
      setUserUsdc(usdcAcc.status === 'fulfilled' ? Number(usdcAcc.value.amount) / 1e6 : 0);
      setUserTokens(tokenAcc.status === 'fulfilled' ? Number(tokenAcc.value.amount) / 1e6 : 0);
    } catch {
      // ignore
    }
  }, [publicKey, vault, connection]);

  useEffect(() => { loadVault(); }, [loadVault]);
  useEffect(() => { loadUserBalances(); }, [loadUserBalances]);

  const handleBuy = async () => {
    if (!publicKey || !vault || !buyAmount) return;
    const amount = parseFloat(buyAmount);
    if (isNaN(amount) || amount <= 0) return;
    setTxLoading(true);
    setTxError(null);
    setTxStatus('Buying...');
    try {
      const provider = getProvider();
      const program = getProgram(provider);
      const tokenMint = new PublicKey(vault.tokenMint);
      const vaultPda = new PublicKey(vaultAddress);
      const [factoryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('factory')],
        new PublicKey(PROGRAM_ID)
      );
      const [usdcVaultPda] = getUsdcVaultPda(vaultPda);
      const [userSharePda] = getUserSharePda(vaultPda, publicKey);
      const userUsdcAta = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), publicKey);
      const userTokenAccount = await getAssociatedTokenAddress(tokenMint, publicKey);

      const tx = await program.methods.buy(
        new anchor.BN(Math.floor(amount * 1e6)),
        new anchor.BN(0)
      ).accounts({
        vault: vaultPda,
        tokenMint,
        usdcVault: usdcVaultPda,
        userShare: userSharePda,
        userUsdc: userUsdcAta,
        userTokenAccount,
        user: publicKey,
        factory: factoryPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc({ commitment: 'confirmed' });

      setTxStatus(`✅ Bought! TX: ${tx.slice(0, 16)}...`);
      setBuyAmount('');
      await Promise.all([loadVault(), loadUserBalances()]);
    } catch (e: unknown) {
      const err = e as { message?: string; logs?: string[] };
      const logs = err.logs ?? [];
      const hint = logs.filter(l => l.includes('Error')).slice(-1).join('');
      setTxError(`Buy failed: ${err.message?.slice(0, 120) ?? 'unknown'}${hint ? ' — ' + hint : ''}`);
      setTxStatus(null);
    } finally {
      setTxLoading(false);
    }
  };

  const handleSell = async () => {
    if (!publicKey || !vault || !sellAmount) return;
    const amount = parseFloat(sellAmount);
    if (isNaN(amount) || amount <= 0) return;
    setTxLoading(true);
    setTxError(null);
    setTxStatus('Selling...');
    try {
      const provider = getProvider();
      const program = getProgram(provider);
      const tokenMint = new PublicKey(vault.tokenMint);
      const vaultPda = new PublicKey(vaultAddress);
      const [factoryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('factory')],
        new PublicKey(PROGRAM_ID)
      );
      const [usdcVaultPda] = getUsdcVaultPda(vaultPda);
      const [userSharePda] = getUserSharePda(vaultPda, publicKey);
      const userUsdcAta = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), publicKey);
      const userTokenAccount = await getAssociatedTokenAddress(tokenMint, publicKey);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const factoryAcc: any = await (program.account as any).factory.fetch(factoryPda);
      const treasuryUsdc = await getAssociatedTokenAddress(
        new PublicKey(USDC_MINT),
        factoryAcc.treasury
      );

      const tx = await program.methods.sell(
        new anchor.BN(Math.floor(amount * 1e6)),
        new anchor.BN(0)
      ).accounts({
        vault: vaultPda,
        tokenMint,
        usdcVault: usdcVaultPda,
        userShare: userSharePda,
        userUsdc: userUsdcAta,
        userTokenAccount,
        treasuryUsdc,
        user: publicKey,
        factory: factoryPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc({ commitment: 'confirmed' });

      setTxStatus(`✅ Sold! TX: ${tx.slice(0, 16)}...`);
      setSellAmount('');
      await Promise.all([loadVault(), loadUserBalances()]);
    } catch (e: unknown) {
      const err = e as { message?: string; logs?: string[] };
      const logs = err.logs ?? [];
      const hint = logs.filter(l => l.includes('Error')).slice(-1).join('');
      setTxError(`Sell failed: ${err.message?.slice(0, 120) ?? 'unknown'}${hint ? ' — ' + hint : ''}`);
      setTxStatus(null);
    } finally {
      setTxLoading(false);
    }
  };

  const handleResetBc = async () => {
    if (!publicKey || !vault) return;
    setTxLoading(true);
    setTxError(null);
    setTxStatus('Resetting BC...');
    try {
      const provider = getProvider();
      const program = getProgram(provider);
      const vaultPda = new PublicKey(vaultAddress);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = await (program.methods as any).resetBc().accounts({
        vault: vaultPda,
        leader: publicKey,
      }).rpc({ commitment: 'confirmed' });
      setTxStatus(`✅ BC Reset! TX: ${tx.slice(0, 16)}...`);
      await loadVault();
    } catch (e: unknown) {
      const err = e as { message?: string };
      setTxError(`Reset failed: ${err.message?.slice(0, 120) ?? 'unknown'}`);
      setTxStatus(null);
    } finally {
      setTxLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-dark flex flex-col text-white">
        <Header
          searchQuery=""
          onSearchChange={() => {}}
          onLogoClick={() => (window.location.href = '/')}
        />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="animate-spin text-primary" size={48} />
        </div>
        <Footer />
      </div>
    );
  }

  if (error || !vault) {
    return (
      <div className="min-h-screen bg-dark flex flex-col text-white">
        <Header
          searchQuery=""
          onSearchChange={() => {}}
          onLogoClick={() => (window.location.href = '/')}
        />
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <p className="text-red-400">{error || 'Vault not found'}</p>
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
        </div>
        <Footer />
      </div>
    );
  }

  const isLeader = publicKey?.toBase58() === vault.leader;

  const totalAssets = vault.usdcReserve + vault.externalAssets;
  const navPrecision = Math.round(vault.nav * 1_000_000);
  const { effBase, effTokens } = getEffectiveVirtuals(
    totalAssets, vault.bcVirtualBase, vault.bcVirtualTokens
  );
  const vbUsdc = getVbUsdc(effBase, navPrecision);

  const spotPrice = effTokens > 0n ? Number(vbUsdc) / Number(effTokens) : 0;

  const buyAmountNum  = parseFloat(buyAmount)  || 0;
  const sellAmountNum = parseFloat(sellAmount) || 0;

  const buyMu  = Math.floor(buyAmountNum  * 1e6);
  const sellMu = Math.floor(sellAmountNum * 1e6);

  const { tokensOut: buyTokensMu, price: buyPriceEff } = bcBuyPrice(vbUsdc, effTokens, buyMu > 0 ? buyMu : 1);
  const sellUsdcMu = bcSellPrice(vbUsdc, effTokens, sellMu > 0 ? sellMu : 1);

  const buyPrice  = buyMu  > 0 ? buyPriceEff                              : spotPrice;
  const sellPrice = sellMu > 0 ? (sellUsdcMu / (sellMu > 0 ? sellMu : 1)) : spotPrice;

  const estTokensOut = buyMu  > 0 ? buyTokensMu / 1e6 : null;
  const estUsdcOut   = sellMu > 0 ? sellUsdcMu  / 1e6 : null;

  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Header
        searchQuery=""
        onSearchChange={() => {}}
        onLogoClick={() => (window.location.href = '/')}
      />

      <main className="flex-1 flex flex-col">
        {/* Sub-header */}
        <div className="border-b border-border px-4 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors">
            <ArrowLeft size={16} />
            <span className="text-sm font-bold uppercase tracking-widest">Vaults</span>
          </Link>
          <button
            onClick={() => { loadVault(); loadUserBalances(); }}
            className="text-gray-500 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        <div className="flex-1 flex flex-col lg:flex-row">
          {/* Left: Chart + Info */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="border-b border-border px-4 py-3 flex flex-wrap items-center gap-4">
              <div>
                <span className="text-xs font-black uppercase tracking-widest text-primary">{vault.symbol}</span>
                <span className="ml-2 text-sm text-gray-400">{vault.name}</span>
              </div>
              <div className="flex flex-wrap gap-4 text-xs">
                <div><span className="text-gray-500">NAV </span><span className="font-mono">${vault.nav.toFixed(4)}</span></div>
                <div><span className="text-gray-500">TVL </span><span className="font-mono">${(vault.usdcReserve + vault.externalAssets).toFixed(2)}</span></div>
                <div><span className="text-gray-500">Reserve </span><span className="font-mono">${vault.usdcReserve.toFixed(2)}</span></div>
                {vault.externalAssets > 0 && (
                  <div><span className="text-gray-500">In Drift </span><span className="font-mono text-blue-400">${vault.externalAssets.toFixed(2)}</span></div>
                )}
              </div>
              <a
                href={getExplorerUrl('account', vaultAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-[10px] text-gray-600 hover:text-primary font-mono"
              >
                {vaultAddress.slice(0, 8)}…
              </a>
            </div>

            <div className="h-[300px] lg:h-[460px] border-b border-border">
              <PriceChart tokenSymbol={vault.symbol} />
            </div>

            <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs border-b border-border">
              <div>
                <span className="text-gray-500 block">Supply</span>
                <span className="font-mono">{vault.totalSupply.toFixed(2)}</span>
              </div>
              <div>
                <span className="text-gray-500 block">Perf Fee</span>
                <span className="font-mono">{(vault.performanceFeeBps / 100).toFixed(1)}%</span>
              </div>
              <div>
                <span className="text-gray-500 block">Leader</span>
                <a
                  href={getExplorerUrl('account', vault.leader)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-primary hover:underline"
                >
                  {vault.leader.slice(0, 6)}…
                </a>
              </div>
              <div>
                <span className="text-gray-500 block">Status</span>
                <span className={vault.isPaused ? 'text-red-400' : 'text-green-400'}>
                  {vault.isPaused ? 'Paused' : 'Active'}
                </span>
              </div>
            </div>
          </div>

          {/* Right: Trading Panel */}
          <div className="w-full lg:w-[380px] border-l border-border flex flex-col">
            <div className="flex border-b border-border">
              <button
                onClick={() => setActiveTab('trading')}
                className={`px-4 py-3 text-[10px] font-black uppercase tracking-widest transition-colors ${
                  activeTab === 'trading' ? 'text-primary border-b-2 border-primary' : 'text-gray-500 hover:text-white'
                }`}
              >
                Trading
              </button>
              {isLeader && (
                <button
                  onClick={() => setActiveTab('leader')}
                  className={`px-4 py-3 text-[10px] font-black uppercase tracking-widest transition-colors ${
                    activeTab === 'leader' ? 'text-yellow-400 border-b-2 border-yellow-400' : 'text-gray-500 hover:text-white'
                  }`}
                >
                  Margin <span className="text-yellow-400 ml-1">(L)</span>
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {activeTab === 'trading' && (
                <div className="space-y-6">
                  {publicKey && (
                    <div className="bg-[#0d1117] rounded-lg p-3 text-xs space-y-1">
                      <div className="flex justify-between">
                        <span className="text-gray-500">Your USDC</span>
                        <span className="text-white">${(userUsdc ?? 0).toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Your {vault.symbol}</span>
                        <span className="text-white">{(userTokens ?? 0).toFixed(4)}</span>
                      </div>
                    </div>
                  )}

                  <div>
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-green-400 mb-3">
                      Buy {vault.symbol}
                    </h3>
                    <div className="text-xs text-gray-500 mb-2">
                      Price: ~${buyPrice.toFixed(6)} / token
                    </div>
                    <input
                      type="number"
                      value={buyAmount}
                      onChange={e => setBuyAmount(e.target.value)}
                      placeholder="USDC amount"
                      className="w-full bg-white/5 border border-border px-3 py-2 text-sm outline-none focus:border-green-500 transition-colors mb-2"
                    />
                    {estTokensOut !== null && (
                      <div className="text-xs text-gray-500 mb-2">
                        ≈ {estTokensOut.toFixed(6)} {vault.symbol} @ ${buyPrice.toFixed(6)}/token
                      </div>
                    )}
                    <button
                      onClick={handleBuy}
                      disabled={!publicKey || !buyAmount || txLoading}
                      className="w-full py-2.5 font-black uppercase tracking-widest text-xs bg-green-500 text-black hover:bg-green-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {txLoading ? 'Processing...' : `Buy ${vault.symbol}`}
                    </button>
                  </div>

                  <div>
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-red-400 mb-3">
                      Sell {vault.symbol}
                    </h3>
                    <div className="text-xs text-gray-500 mb-2">
                      Price: ~${sellPrice.toFixed(6)} / token
                    </div>
                    <input
                      type="number"
                      value={sellAmount}
                      onChange={e => setSellAmount(e.target.value)}
                      placeholder="Token amount"
                      className="w-full bg-white/5 border border-border px-3 py-2 text-sm outline-none focus:border-red-500 transition-colors mb-2"
                    />
                    {estUsdcOut !== null && (
                      <div className="text-xs text-gray-500 mb-2">
                        ≈ ${estUsdcOut.toFixed(6)} USDC @ ${sellPrice.toFixed(6)}/token
                      </div>
                    )}
                    <button
                      onClick={handleSell}
                      disabled={!publicKey || !sellAmount || txLoading}
                      className="w-full py-2.5 font-black uppercase tracking-widest text-xs bg-red-500 text-black hover:bg-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {txLoading ? 'Processing...' : `Sell ${vault.symbol}`}
                    </button>
                  </div>

                  {txStatus && (
                    <div className="text-xs px-3 py-2 bg-green-900/20 border border-green-800 text-green-400 rounded break-all">
                      {txStatus}
                    </div>
                  )}
                  {txError && (
                    <div className="text-xs px-3 py-2 bg-red-900/20 border border-red-800 text-red-400 rounded break-all">
                      {txError}
                    </div>
                  )}

                  {!publicKey && (
                    <div className="text-center pt-2">
                      <WalletMultiButton />
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'leader' && isLeader && (
                <div className="mb-4 p-3 bg-[#0d1117] rounded-lg border border-yellow-900/30">
                  <div className="text-xs text-gray-500 mb-2">BC State: vBase <span className="font-mono text-white">{(vault.bcVirtualBase / 1e6).toFixed(0)}</span> / vTokens <span className="font-mono text-white">{(vault.bcVirtualTokens / 1e6).toFixed(0)}</span></div>
                  <button
                    onClick={handleResetBc}
                    disabled={txLoading}
                    className="w-full py-2 text-xs font-bold uppercase tracking-widest rounded bg-yellow-900/40 text-yellow-400 hover:bg-yellow-900/60 disabled:opacity-50"
                  >
                    Reset BC to Default (2M/2M)
                  </button>
                  <p className="text-[10px] text-gray-600 mt-1">Use if price is stuck at cap after repeated buy/sell</p>
                </div>
              )}

              {activeTab === 'leader' && isLeader && (
                <MarginTradingPanel
                  vaultPda={vaultAddress}
                  leaderAddress={vault.leader}
                  usdcReserve={vault.usdcReserve}
                />
              )}
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
