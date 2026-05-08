'use client';

import { useCallback, useEffect, useMemo, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import * as anchor from '@coral-xyz/anchor';
import {
  ArrowLeft,
  Copy,
  Loader2,
  ExternalLink,
  RefreshCw,
  Globe,
  Send,
} from 'lucide-react';

import Header from '@/components/Header';
import Footer from '@/components/Footer';
import {
  PROGRAM_ID,
  USDC_MINT,
  getExplorerUrl,
} from '@/lib/contracts/config';
import {
  getProgram,
  getUsdcVaultPda,
  getUserSharePda,
} from '@/lib/contracts/margin';
import { parseMetadata, type VaultLinks } from '@/lib/vaults';
import { invalidateVault } from '@/lib/vault-data-cache';

// ─── Dynamic / lazy components ──────────────────────────────────────────────
const AdvancedChart = dynamic(
  () => import('@/components/bonding-curve-vault/AdvancedChart'),
  {
    ssr: false,
    loading: () => (
      <div className="bg-[#131722] h-full flex items-center justify-center">
        <Loader2 className="animate-spin text-primary" size={24} />
      </div>
    ),
  },
);
const MarginTradingPanel = dynamic(
  () => import('@/components/bonding-curve-vault/MarginTradingPanel'),
  { ssr: false },
);
const SimulationPanel = dynamic(
  () => import('@/components/bonding-curve-vault/SimulationPanel'),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-primary" size={28} />
      </div>
    ),
  },
);
const ActivityTabs = dynamic(
  () => import('@/components/bonding-curve-vault/ActivityTabs'),
  { ssr: false },
);

// ─── Types ──────────────────────────────────────────────────────────────────
interface VaultOnChain {
  address: string;
  leader: string;
  name: string;
  symbol: string;
  metadataUri: string;
  tokenMint: string;
  usdcReserve: number;       // human (USDC)
  externalAssets: number;    // human
  totalSupply: number;       // human (vault token)
  performanceFeeBps: number;
  isPaused: boolean;
  bcVirtualBase: number;     // raw on-chain (µ)
  bcVirtualTokens: number;   // raw on-chain (µ)
  imageUrl?: string;
  description?: string;
  links?: VaultLinks;
}

type Tab = 'trading' | 'margin' | 'report';

interface GraduationTier {
  label: string;
  threshold: number;   // total assets in USD
  bcVirtual: number;   // virtual depth (µ → human)
  navMinMul: number;
  navMaxMul: number;
  sqBps: number;
}

// Mirror of EVM tier table — kept as static reference until factory tier
// decoder is plumbed through to the Solana program account parser.
const DEFAULT_TIERS: GraduationTier[] = [
  { label: '🔥Seed',      threshold: 100_000,     bcVirtual: 1_000_000,   navMinMul: 0.01, navMaxMul: 0.02, sqBps: 9000 },
  { label: '💎Growth',    threshold: 1_000_000,   bcVirtual: 10_000_000,  navMinMul: 0.1,  navMaxMul: 0.2,  sqBps: 6000 },
  { label: '🏆Mature',    threshold: 10_000_000,  bcVirtual: 20_000_000,  navMinMul: 0.4,  navMaxMul: 0.6,  sqBps: 1500 },
  { label: '👑Graduated', threshold: 100_000_000, bcVirtual: 100_000_000, navMinMul: 0.8,  navMaxMul: 1.2,  sqBps: 200  },
];

// ─── Bonding curve math (matches Rust program) ──────────────────────────────
function calcBuyTokens(vBase: bigint, vTokens: bigint, usdcInMicro: bigint): bigint {
  if (vBase <= 0n || vTokens <= 0n || usdcInMicro <= 0n) return 0n;
  return (vTokens * usdcInMicro) / (vBase + usdcInMicro);
}
function calcSellUsdc(vBase: bigint, vTokens: bigint, tokensInMicro: bigint): bigint {
  if (vBase <= 0n || vTokens <= 0n || tokensInMicro <= 0n) return 0n;
  return (vBase * tokensInMicro) / (vTokens + tokensInMicro);
}

// ─── Page ───────────────────────────────────────────────────────────────────
export default function VaultPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { id: vaultAddress } = use(params);

  const { publicKey, signTransaction, signAllTransactions, connected } = useWallet();
  const { connection } = useConnection();

  const [vault, setVault] = useState<VaultOnChain | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<Tab>('trading');

  // Trading
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [txLoading, setTxLoading] = useState(false);
  const [txStatus, setTxStatus] = useState<{
    kind: 'ok' | 'err' | 'info';
    msg: string;
    sig?: string;
  } | null>(null);

  // Balances
  const [userUsdc, setUserUsdc] = useState<number | null>(null);
  const [userTokens, setUserTokens] = useState<number | null>(null);

  // Admin
  const [adminBusy, setAdminBusy] = useState(false);

  const isLeader = !!publicKey && !!vault && publicKey.toBase58() === vault.leader;

  // ─── Provider helper ──────────────────────────────────────────────────
  const getProvider = useCallback((): anchor.AnchorProvider => {
    if (publicKey && signTransaction && signAllTransactions) {
      return new anchor.AnchorProvider(
        connection,
        { publicKey, signTransaction, signAllTransactions },
        { commitment: 'confirmed' },
      );
    }
    return new anchor.AnchorProvider(
      connection,
      {
        publicKey: PublicKey.default,
        signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
        signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs,
      },
      { commitment: 'confirmed' },
    );
  }, [publicKey, signTransaction, signAllTransactions, connection]);

  // ─── Load vault state ─────────────────────────────────────────────────
  const loadVault = useCallback(async () => {
    setError(null);
    try {
      const provider = getProvider();
      const program = getProgram(provider);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acc: any = await (program.account as any).vault.fetch(
        new PublicKey(vaultAddress),
      );

      const usdcReserve = acc.usdcReserve.toNumber() / 1e6;
      const externalAssets = acc.externalAssets.toNumber() / 1e6;
      const totalSupply = acc.totalSupply.toNumber() / 1e6;

      const base: VaultOnChain = {
        address: vaultAddress,
        leader: acc.leader.toBase58(),
        name: acc.name,
        symbol: acc.symbol,
        metadataUri: acc.metadataUri ?? '',
        tokenMint: acc.tokenMint.toBase58(),
        usdcReserve,
        externalAssets,
        totalSupply,
        performanceFeeBps: acc.performanceFeeBps ?? 0,
        isPaused: acc.isPaused ?? false,
        bcVirtualBase: acc.bcVirtualBase?.toNumber?.() ?? 0,
        bcVirtualTokens: acc.bcVirtualTokens?.toNumber?.() ?? 0,
      };

      if (base.metadataUri) {
        try {
          const meta = await parseMetadata(base.metadataUri);
          base.imageUrl = meta.imageUrl;
          base.description = meta.description;
          base.links = meta.links;
        } catch { /* ignore */ }
      }

      setVault(base);
    } catch (e) {
      console.error('[loadVault] error:', e);
      setError('Vault not found on-chain.');
    } finally {
      setLoading(false);
    }
  }, [vaultAddress, getProvider]);

  // ─── Load user balances ───────────────────────────────────────────────
  const loadUserBalances = useCallback(async () => {
    if (!publicKey || !vault) {
      setUserUsdc(null);
      setUserTokens(null);
      return;
    }
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
      setUserUsdc(0);
      setUserTokens(0);
    }
  }, [publicKey, vault, connection]);

  useEffect(() => { loadVault(); }, [loadVault]);
  useEffect(() => { loadUserBalances(); }, [loadUserBalances]);

  // ─── Derived values ───────────────────────────────────────────────────
  const totalAssets = vault ? vault.usdcReserve + vault.externalAssets : 0;

  const { buyPrice, sellPrice, mcap, rawNav, stabNav } = useMemo(() => {
    if (!vault) return { buyPrice: 0, sellPrice: 0, mcap: 0, rawNav: 0, stabNav: 0 };
    const vBase = BigInt(vault.bcVirtualBase);
    const vTokens = BigInt(vault.bcVirtualTokens);
    // 1 USDC -> tokens, derive price
    const oneUsdc = 1_000_000n;
    const tOut = calcBuyTokens(vBase, vTokens, oneUsdc);
    const buyP = tOut > 0n ? Number(oneUsdc) / Number(tOut) : 0;
    // 1 token -> usdc
    const oneToken = 1_000_000n;
    const uOut = calcSellUsdc(vBase, vTokens, oneToken);
    const sellP = oneToken > 0n ? Number(uOut) / Number(oneToken) : 0;
    const mc = buyP * vault.totalSupply;
    const rNav = vault.totalSupply > 0 ? totalAssets / vault.totalSupply : 1;
    return { buyPrice: buyP, sellPrice: sellP, mcap: mc, rawNav: rNav, stabNav: buyP };
  }, [vault, totalAssets]);

  // ─── Trade preview ────────────────────────────────────────────────────
  const preview = useMemo(() => {
    if (!vault || !amount) return null;
    const n = parseFloat(amount);
    if (!n || isNaN(n) || n <= 0) return null;
    const vBase = BigInt(vault.bcVirtualBase);
    const vTokens = BigInt(vault.bcVirtualTokens);
    if (side === 'buy') {
      const out = calcBuyTokens(vBase, vTokens, BigInt(Math.floor(n * 1e6)));
      return { out: Number(out) / 1e6, isBuy: true };
    }
    const out = calcSellUsdc(vBase, vTokens, BigInt(Math.floor(n * 1e6)));
    return { out: Number(out) / 1e6, isBuy: false };
  }, [amount, side, vault]);

  // ─── Submit trade ─────────────────────────────────────────────────────
  const submitTrade = async () => {
    if (!publicKey || !vault) {
      setTxStatus({ kind: 'err', msg: 'Connect a wallet first.' });
      return;
    }
    const n = parseFloat(amount);
    if (!n || isNaN(n) || n <= 0) {
      setTxStatus({ kind: 'err', msg: 'Enter a valid amount.' });
      return;
    }
    setTxLoading(true);
    setTxStatus({ kind: 'info', msg: side === 'buy' ? 'Buying…' : 'Selling…' });
    try {
      const provider = getProvider();
      const program = getProgram(provider);
      const tokenMint = new PublicKey(vault.tokenMint);
      const vaultPda = new PublicKey(vault.address);
      const [factoryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('factory')],
        new PublicKey(PROGRAM_ID),
      );
      const [usdcVaultPda] = getUsdcVaultPda(vaultPda);
      const [userSharePda] = getUserSharePda(vaultPda, publicKey);
      const userUsdcAta = await getAssociatedTokenAddress(new PublicKey(USDC_MINT), publicKey);
      const userTokenAccount = await getAssociatedTokenAddress(tokenMint, publicKey);

      let sig: string;
      if (side === 'buy') {
        sig = await program.methods
          .buy(new anchor.BN(Math.floor(n * 1e6)), new anchor.BN(0))
          .accounts({
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
          })
          .rpc({ commitment: 'confirmed' });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const factoryAcc: any = await (program.account as any).factory.fetch(factoryPda);
        const treasuryUsdc = await getAssociatedTokenAddress(
          new PublicKey(USDC_MINT),
          factoryAcc.treasury,
        );
        sig = await program.methods
          .sell(new anchor.BN(Math.floor(n * 1e6)), new anchor.BN(0))
          .accounts({
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
          })
          .rpc({ commitment: 'confirmed' });
      }
      setTxStatus({
        kind: 'ok',
        msg: side === 'buy' ? 'Buy successful!' : 'Sell successful!',
        sig,
      });
      setAmount('');
      // Force history / chart / holders to pick up the new trade without
      // waiting for the 2-minute server cache TTL.
      invalidateVault(vault.address);
      await Promise.all([loadVault(), loadUserBalances()]);
    } catch (e: unknown) {
      const err = e as { message?: string; logs?: string[] };
      const logHint = (err.logs ?? [])
        .filter((l) => l.includes('Error'))
        .slice(-1)
        .join('');
      setTxStatus({
        kind: 'err',
        msg: `${side === 'buy' ? 'Buy' : 'Sell'} failed: ${
          err.message?.slice(0, 140) ?? 'unknown'
        }${logHint ? ' — ' + logHint : ''}`,
      });
    } finally {
      setTxLoading(false);
    }
  };

  // ─── Admin: pause/unpause ─────────────────────────────────────────────
  const handleSetPaused = async (paused: boolean) => {
    if (!publicKey || !vault) return;
    setAdminBusy(true);
    setTxStatus({ kind: 'info', msg: paused ? 'Pausing…' : 'Unpausing…' });
    try {
      const provider = getProvider();
      const program = getProgram(provider);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sig = await (program.methods as any)
        .setPaused(paused)
        .accounts({
          vault: new PublicKey(vault.address),
          leader: publicKey,
        })
        .rpc({ commitment: 'confirmed' });
      setTxStatus({
        kind: 'ok',
        msg: paused ? 'Vault paused.' : 'Vault unpaused.',
        sig,
      });
      await loadVault();
    } catch (e: unknown) {
      const err = e as { message?: string };
      setTxStatus({
        kind: 'err',
        msg: `Set paused failed: ${err.message?.slice(0, 140) ?? 'unknown'}`,
      });
    } finally {
      setAdminBusy(false);
    }
  };

  // ─── Render: loading / error ─────────────────────────────────────────
  if (loading) {
    return (
      <Shell>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="animate-spin text-primary" size={48} />
        </div>
      </Shell>
    );
  }
  if (error || !vault) {
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <p className="text-red-400">{error || 'Vault not found'}</p>
          <button
            onClick={() => router.push('/')}
            className="text-primary hover:underline"
          >
            ← Back to Home
          </button>
        </div>
      </Shell>
    );
  }

  // ─── Render: main ─────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Header
        searchQuery=""
        onSearchChange={() => {}}
        onLogoClick={() => router.push('/')}
      />

      {/* ─── Vault top header (image + name + stats grid) ─────────────── */}
      <VaultTopHeader
        vault={vault}
        isLeader={isLeader}
        buyPrice={buyPrice}
        sellPrice={sellPrice}
        mcap={mcap}
        totalAssets={totalAssets}
        rawNav={rawNav}
        onBack={() => router.push('/')}
      />

      {/* ─── Tabs ──────────────────────────────────────────────────────── */}
      <div className="flex border-b border-border bg-card">
        <TabButton active={activeTab === 'trading'} onClick={() => setActiveTab('trading')}>
          Trading
        </TabButton>
        {isLeader && (
          <TabButton
            active={activeTab === 'margin'}
            onClick={() => setActiveTab('margin')}
            accent="purple"
          >
            Drift Margin Trading
          </TabButton>
        )}
        <TabButton
          active={activeTab === 'report'}
          onClick={() => setActiveTab('report')}
          accent="green"
        >
          Report
        </TabButton>
        <button
          onClick={() => {
            invalidateVault(vault.address);
            loadVault();
            loadUserBalances();
          }}
          className="ml-auto px-3 text-gray-400 hover:text-primary cursor-pointer flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest"
          title="Refresh"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* ─── Main content ──────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col">
        {activeTab === 'trading' && (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_460px] gap-px bg-border">
            {/* Left column: chart + activity tabs */}
            <div className="flex flex-col min-w-0">
              <div className="bg-[#131722] h-[500px] lg:h-[560px]">
                <AdvancedChart
                  vaultAddress={vault.address}
                  tokenSymbol={vault.symbol || '???'}
                  currentPrice={buyPrice}
                />
              </div>
              <ActivityTabs
                vaultAddress={vault.address}
                leaderAddress={vault.leader}
              />
            </div>

            {/* Right rail: full height of left column */}
            <aside className="bg-card overflow-y-auto max-h-[calc(100vh-200px)]">
              <TradingRail
                vault={vault}
                side={side}
                setSide={setSide}
                amount={amount}
                setAmount={setAmount}
                preview={preview}
                userUsdc={userUsdc}
                userTokens={userTokens}
                connected={connected}
                txLoading={txLoading}
                txStatus={txStatus}
                rawNav={rawNav}
                stabNav={stabNav}
                totalAssets={totalAssets}
                onSubmit={submitTrade}
              />
            </aside>
          </div>
        )}

        {activeTab === 'margin' && isLeader && (
          <div className="flex-1 flex flex-col min-h-0">
            <MarginTradingPanel
              vaultPda={vault.address}
              leaderAddress={vault.leader}
              usdcReserve={vault.usdcReserve}
            />
          </div>
        )}

        {activeTab === 'report' && (
          <div className="h-full">
            {/* Trading report — driven by /api/vault/report (cached server-side) */}
            <SimulationPanel
              vaultAddress={vault.address}
              vBase={vault.bcVirtualBase}
              vTokens={vault.bcVirtualTokens}
              tradingFeeBps={100}
              performanceFeeBps={vault.performanceFeeBps}
              maxPremiumBps={10000}
              maxDiscountBps={5000}
              navVirtualMul={0.01}
            />
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ─── Top header (matches HyperVapor screenshot) ────────────────────────────
// ────────────────────────────────────────────────────────────────────────────
function VaultTopHeader({
  vault,
  isLeader,
  buyPrice,
  sellPrice,
  mcap,
  totalAssets,
  rawNav,
  onBack,
}: {
  vault: VaultOnChain;
  isLeader: boolean;
  buyPrice: number;
  sellPrice: number;
  mcap: number;
  totalAssets: number;
  rawNav: number;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState(false);

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="bg-card border-b border-border">
      {/* Mobile compact */}
      <div className="md:hidden px-2 py-1.5">
        <div className="flex items-center gap-2 mb-1">
          <button
            onClick={onBack}
            className="w-6 h-6 flex cursor-pointer items-center justify-center border border-border hover:bg-white/5 text-gray-500 hover:text-white shrink-0"
          >
            <ArrowLeft size={12} />
          </button>
          <div className="w-7 h-7 border border-border bg-black relative shrink-0 overflow-hidden">
            {vault.imageUrl && !imgErr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={vault.imageUrl}
                alt={vault.name}
                className="w-full h-full object-cover"
                onError={() => setImgErr(true)}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs font-bold text-gray-500">
                {vault.symbol?.slice(0, 2) || '??'}
              </div>
            )}
          </div>
          <span className="text-sm font-black uppercase italic text-white tracking-tighter truncate">
            {vault.name}
          </span>
          <span className="text-[9px] font-mono font-bold text-primary bg-primary/10 px-2 py-1 border border-primary/20 shrink-0 h-5 flex items-center">
            ${vault.symbol}
          </span>
          {isLeader && (
            <span className="text-[9px] font-bold text-green-400 bg-green-400/10 px-2 py-1 border border-green-400/20 shrink-0 h-5 flex items-center">
              Leader
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 text-[9px] font-mono text-gray-400 gap-1">
          <Stat label="MCap" value={`$${mcap.toFixed(0)}`} accent="text-white" />
          <Stat label="Buy" value={`$${buyPrice.toFixed(4)}`} accent="text-primary" />
          <Stat label="Sell" value={`$${sellPrice.toFixed(4)}`} accent="text-red-400" />
          <Stat label="Assets" value={`$${totalAssets.toFixed(2)}`} accent="text-cyan-400" />
          <Stat label="Supply" value={vault.totalSupply.toFixed(2)} accent="text-white" />
          <Stat label="NAV" value={`$${rawNav.toFixed(4)}`} accent="text-white" />
        </div>
      </div>

      {/* Desktop wide */}
      <div className="hidden md:flex py-4 px-6 items-center justify-between gap-4">
        {/* Left side: back + image + name + meta */}
        <div className="flex items-center gap-4 min-w-0">
          <button
            onClick={onBack}
            className="w-10 h-10 flex cursor-pointer items-center justify-center border border-border hover:bg-white/5 transition-all text-gray-500 hover:text-white shrink-0"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="w-20 h-20 border border-border bg-black shadow-2xl relative shrink-0 overflow-hidden">
            {vault.imageUrl && !imgErr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={vault.imageUrl}
                alt={vault.name}
                className="w-full h-full object-cover"
                onError={() => setImgErr(true)}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-2xl font-bold text-gray-500">
                {vault.symbol?.slice(0, 2) || '??'}
              </div>
            )}
            <div className="absolute inset-0 border-4 border-white/5 pointer-events-none" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-black uppercase italic text-white tracking-tighter truncate pr-2">
                {vault.name}
              </h1>
              <span className="text-xs font-mono font-bold text-primary bg-primary/10 px-2.5 border border-primary/20 shrink-0 h-6 flex items-center">
                ${vault.symbol}
              </span>
              {isLeader && (
                <span className="text-xs font-bold text-green-400 bg-green-400/10 px-2.5 border border-green-400/20 uppercase tracking-wider shrink-0 h-6 flex items-center">
                  Leader
                </span>
              )}
              <span className="text-xs font-bold text-blue-400 bg-blue-400/10 px-2.5 border border-blue-400/20 uppercase tracking-wider shrink-0 h-6 flex items-center">
                Fee: {(vault.performanceFeeBps / 100).toFixed(2)}%
              </span>
              {vault.isPaused && (
                <span className="text-xs font-bold text-rose-400 bg-rose-400/10 px-2.5 border border-rose-400/20 uppercase tracking-wider shrink-0 h-6 flex items-center">
                  Paused
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={() => copy(vault.address, 'contract')}
                className="text-xs font-mono uppercase tracking-[0.2em] cursor-pointer hover:text-white group flex items-center gap-1"
              >
                <span className="text-gray-500">Contract: </span>
                <span className="text-primary group-hover:text-white">
                  {short(vault.address)}
                </span>
                <Copy size={10} className="text-gray-500 group-hover:text-white" />
                {copied === 'contract' && <span className="text-green-400 ml-1">✓</span>}
              </button>
              <button
                onClick={() => copy(vault.leader, 'leader')}
                className="text-xs font-mono uppercase tracking-[0.2em] cursor-pointer hover:text-white group flex items-center gap-1"
              >
                <span className="text-gray-500">Leader: </span>
                <span className="text-primary group-hover:text-white">
                  {short(vault.leader)}
                </span>
                <Copy size={10} className="text-gray-500 group-hover:text-white" />
                {copied === 'leader' && <span className="text-green-400 ml-1">✓</span>}
              </button>
            </div>
          </div>
        </div>

        {/* Right side: stats grid */}
        <div className="flex gap-6 bg-black/40 border border-white/5 p-4 backdrop-blur-sm">
          <BigStat label="MCap" value={`$${mcap.toFixed(2)}`} accent="text-white" />
          <BigStat label="Assets" value={`$${totalAssets.toFixed(2)}`} accent="text-cyan-400" />
          <BigStat label="Supply" value={vault.totalSupply.toFixed(2)} accent="text-white" />
          <BigStat label="Buy" value={`$${buyPrice.toFixed(4)}`} accent="text-primary" />
          <BigStat label="Sell" value={`$${sellPrice.toFixed(4)}`} accent="text-red-400" />
          <BigStat label="NAV" value={`$${rawNav.toFixed(4)}`} accent="text-white" />
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ─── Right trading rail (Buy/Sell + Reserve + Social + NAV + Tiers) ────────
// ────────────────────────────────────────────────────────────────────────────
function TradingRail({
  vault,
  side,
  setSide,
  amount,
  setAmount,
  preview,
  userUsdc,
  userTokens,
  connected,
  txLoading,
  txStatus,
  rawNav,
  stabNav,
  totalAssets,
  onSubmit,
}: {
  vault: VaultOnChain;
  side: 'buy' | 'sell';
  setSide: (s: 'buy' | 'sell') => void;
  amount: string;
  setAmount: (v: string) => void;
  preview: { out: number; isBuy: boolean } | null;
  userUsdc: number | null;
  userTokens: number | null;
  connected: boolean;
  txLoading: boolean;
  txStatus: { kind: 'ok' | 'err' | 'info'; msg: string; sig?: string } | null;
  rawNav: number;
  stabNav: number;
  totalAssets: number;
  onSubmit: () => void;
}) {
  const balance = side === 'buy' ? userUsdc : userTokens;
  const balanceLabel = side === 'buy' ? 'USDC' : vault.symbol;

  const setPercent = (pct: number) => {
    if (balance == null) return;
    setAmount(((balance * pct) / 100).toFixed(side === 'buy' ? 2 : 4));
  };

  const tier = pickCurrentTier(totalAssets);

  return (
    <div className="flex flex-col">
      {/* Buy / Sell pill tabs */}
      <div className="grid grid-cols-2 m-2 border border-border">
        <button
          onClick={() => setSide('buy')}
          className={`py-2.5 text-xs font-black uppercase tracking-widest transition-colors ${
            side === 'buy'
              ? 'bg-primary text-black'
              : 'bg-black text-gray-500 hover:text-white'
          }`}
        >
          Buy
        </button>
        <button
          onClick={() => setSide('sell')}
          className={`py-2.5 text-xs font-black uppercase tracking-widest transition-colors ${
            side === 'sell'
              ? 'bg-red-500 text-white'
              : 'bg-black text-gray-500 hover:text-white'
          }`}
        >
          Sell
        </button>
      </div>

      {/* Amount input */}
      <div className="px-3 space-y-2">
        <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest">
          <span className="text-gray-500">Amount</span>
          <span className="text-gray-500">
            Bal: <span className="text-gray-300">
              {balance == null ? '—' : balance.toFixed(side === 'buy' ? 2 : 4)}
            </span>
          </span>
        </div>
        <div className="relative flex items-center bg-black border border-border focus-within:border-primary transition-colors">
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={side === 'buy' ? 'Min 5' : '0.00'}
            className="flex-1 bg-transparent px-3 py-3 text-2xl text-white font-mono font-bold focus:outline-none"
          />
          <span className="absolute right-3 text-[11px] font-mono font-bold text-gray-500 uppercase tracking-widest">
            {balanceLabel}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {[10, 25, 50, 100].map((p) => (
            <button
              key={p}
              onClick={() => setPercent(p)}
              disabled={balance == null}
              className="py-1.5 bg-black border border-border text-[11px] font-bold text-gray-400 hover:text-primary hover:border-primary/50 disabled:opacity-40 transition-colors"
            >
              {p}%
            </button>
          ))}
        </div>

        {preview && (
          <div className="text-[11px] font-mono text-gray-400">
            ≈{' '}
            <span className={preview.isBuy ? 'text-primary' : 'text-red-400'}>
              {preview.isBuy
                ? `${preview.out.toFixed(4)} ${vault.symbol}`
                : `$${preview.out.toFixed(4)} USDC`}
            </span>
          </div>
        )}

        {/* Action button */}
        {!connected ? (
          <WalletMultiButton style={{ width: '100%', justifyContent: 'center' }} />
        ) : (
          <button
            onClick={onSubmit}
            disabled={txLoading || !amount || vault.isPaused}
            className={`w-full py-3 text-xs font-black uppercase tracking-[0.3em] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all ${
              side === 'buy'
                ? 'bg-primary text-black hover:brightness-110'
                : 'bg-red-500 text-white hover:brightness-110'
            }`}
          >
            {txLoading && <Loader2 size={14} className="animate-spin" />}
            {vault.isPaused ? 'Paused' : txLoading ? '...' : side.toUpperCase()}
          </button>
        )}

        {txStatus && (
          <div
            className={`p-2 text-[11px] font-mono break-all border ${
              txStatus.kind === 'ok'
                ? 'border-green-500/40 bg-green-500/5 text-green-400'
                : txStatus.kind === 'err'
                ? 'border-red-500/40 bg-red-500/5 text-red-400'
                : 'border-yellow-500/40 bg-yellow-500/5 text-yellow-400'
            }`}
          >
            <div>{txStatus.msg}</div>
            {txStatus.sig && (
              <a
                href={getExplorerUrl('tx', txStatus.sig)}
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

      {/* Reserve block */}
      <div className="mt-3 px-3 pt-3 border-t border-border">
        <div className="text-xs font-black uppercase tracking-widest text-gray-500 mb-2">
          Reserve
        </div>
        <div className="grid grid-cols-3 gap-1.5 font-mono text-sm">
          <ReserveCell label="USDC" value={`$${vault.usdcReserve.toFixed(2)}`} />
          <ReserveCell label="External" value={`$${vault.externalAssets.toFixed(2)}`} />
          <ReserveCell label="Total" value={`$${totalAssets.toFixed(2)}`} accent="text-primary" />
        </div>
      </div>

      {/* Social links */}
      {(vault.links?.website || vault.links?.twitter || vault.links?.telegram) && (
        <div className="mt-3 px-3 pt-3 border-t border-border">
          <div className="text-xs font-black uppercase tracking-widest text-gray-500 mb-2">
            Social Links
          </div>
          <div className="flex gap-2">
            {vault.links?.website && (
              <SocialIcon href={vault.links.website} icon={<Globe size={16} />} />
            )}
            {vault.links?.twitter && (
              <SocialIcon
                href={vault.links.twitter}
                icon={<span className="text-[12px] font-black">𝕏</span>}
              />
            )}
            {vault.links?.telegram && (
              <SocialIcon href={vault.links.telegram} icon={<Send size={16} />} />
            )}
          </div>
        </div>
      )}

      {/* NAV stabilization */}
      <div className="mt-3 px-3 pt-3 border-t border-border">
        <div className="text-xs font-black uppercase tracking-widest text-gray-500 mb-2">
          NAV Stabilization
        </div>
        <div className="grid grid-cols-2 gap-1.5 mb-2">
          <NavCell label="Assets" value={formatNum(totalAssets)} accent="text-white" />
          <NavCell label="Supply" value={formatNum(vault.totalSupply)} accent="text-white" />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <NavCell label="Raw NAV" value={`$${rawNav.toFixed(4)}`} accent="text-yellow-400" />
          <NavCell label="Stab NAV" value={`$${stabNav.toFixed(4)}`} accent="text-orange-400" />
          <NavCell label="TWAP" value={`$${stabNav.toFixed(4)}`} accent="text-primary" />
        </div>
      </div>

      {/* Graduation tiers */}
      <div className="mt-3 px-3 pt-3 pb-4 border-t border-border">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs font-black uppercase tracking-widest text-gray-500">
            Graduation Tiers
          </div>
          <div className="text-[10px] font-mono text-green-400">
            ✓ {DEFAULT_TIERS.length} tiers
          </div>
        </div>
        <div className="text-[10px] font-mono text-gray-400 mb-2">
          vBase {formatNum(vault.bcVirtualBase / 1e6)} / vTokens {formatNum(vault.bcVirtualTokens / 1e6)}
        </div>
        <div className="text-[10px]">
          <div className="grid grid-cols-5 px-1 py-1 text-gray-500 border-b border-border font-bold">
            <div>Tier</div>
            <div className="text-right">Threshold</div>
            <div className="text-right">BC</div>
            <div className="text-right">NAV Mul</div>
            <div className="text-right">Sq²</div>
          </div>
          {DEFAULT_TIERS.map((t, i) => {
            const isCur = tier?.label === t.label;
            return (
              <div
                key={i}
                className={`grid grid-cols-5 px-1 py-1 ${isCur ? 'bg-white/10' : ''}`}
              >
                <div className={isCur ? 'text-white font-bold' : 'text-gray-400 font-bold'}>
                  {t.label}
                </div>
                <div className={`text-right font-mono ${isCur ? 'text-white' : 'text-gray-500'}`}>
                  ${formatNum(t.threshold)}
                </div>
                <div className={`text-right font-mono ${isCur ? 'text-white' : 'text-gray-500'}`}>
                  {formatNum(t.bcVirtual)}
                </div>
                <div className={`text-right font-mono ${isCur ? 'text-white' : 'text-gray-500'}`}>
                  {t.navMinMul}-{t.navMaxMul}x
                </div>
                <div className={`text-right font-mono ${isCur ? 'text-white' : 'text-gray-500'}`}>
                  {(t.sqBps / 100).toFixed(0)}%
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ─── Tiny presentational helpers ────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────────
function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Header
        searchQuery=""
        onSearchChange={() => {}}
        onLogoClick={() => router.push('/')}
      />
      {children}
      <Footer />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  accent?: 'green' | 'purple';
}) {
  const activeColor =
    accent === 'green'
      ? 'text-green-400 border-green-400'
      : accent === 'purple'
      ? 'text-purple-400 border-purple-400'
      : 'text-primary border-primary';
  return (
    <button
      onClick={onClick}
      className={`px-4 sm:px-6 py-2.5 cursor-pointer font-black uppercase tracking-widest text-[11px] transition-colors whitespace-nowrap ${
        active ? `${activeColor} border-b-2` : 'text-gray-500 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border bg-card">
      <div className="px-4 py-2 border-b border-border">
        <div className="text-[10px] font-mono text-primary uppercase tracking-widest font-bold">
          {title}
        </div>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function KV({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="bg-black/60 px-3 py-2.5">
      <div className="text-[9px] font-mono text-gray-500 uppercase tracking-widest mb-0.5">
        {label}
      </div>
      <div className={`font-mono text-sm font-bold ${accent} truncate`}>{value}</div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <span className="text-center">
      {label}
      <br />
      <span className={`font-bold ${accent}`}>{value}</span>
    </span>
  );
}

function BigStat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="flex flex-col p-1">
      <span className="text-xs font-black text-gray-500 uppercase tracking-widest mb-1">
        {label}
      </span>
      <span className={`text-xl font-mono font-bold tracking-tighter ${accent}`}>{value}</span>
    </div>
  );
}

function ReserveCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="bg-black/40 border border-white/5 p-1.5">
      <div className="text-gray-500 uppercase text-[10px] font-bold tracking-widest">
        {label}
      </div>
      <div className={`font-mono font-bold text-sm ${accent ?? 'text-white'}`}>{value}</div>
    </div>
  );
}

function NavCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="bg-black/40 p-1.5 border border-white/5">
      <div className="text-gray-500 text-[10px]">{label}</div>
      <div className={`font-mono font-bold text-xs ${accent}`}>{value}</div>
    </div>
  );
}

function SocialIcon({ href, icon }: { href: string; icon: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-center w-9 h-9 bg-black/40 border border-border hover:border-primary/50 text-gray-400 hover:text-primary transition-colors"
    >
      {icon}
    </a>
  );
}

function pickCurrentTier(totalAssets: number): GraduationTier {
  for (const t of DEFAULT_TIERS) {
    if (totalAssets < t.threshold) return t;
  }
  return DEFAULT_TIERS[DEFAULT_TIERS.length - 1];
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  if (n >= 1) return n.toFixed(0);
  if (n > 0) return n.toFixed(2);
  return '0';
}

function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}
