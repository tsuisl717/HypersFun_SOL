'use client';

/**
 * MarginTradingPanel — Leader-only Drift Protocol CPI margin trading.
 * Layout: markets list (left) / chart + positions (center) / trade form (right).
 */

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { Search, ExternalLink, Loader2, Lock } from 'lucide-react';

import {
  fetchMarginPosition,
  fetchDriftUserAccount,
  buildInitDriftAccountTx,
  buildOpenMarginPositionTx,
  buildCloseMarginPositionTx,
  buildWithdrawDriftUsdcTx,
  getMarginPositionPda,
  MarginPositionState,
  DriftUserAccountState,
  PERP_MARKETS,
} from '@/lib/contracts/margin';
import { NETWORK } from '@/lib/contracts/config';
import {
  fetchDriftMarkets,
  fetchPerpMarketInfo,
  getPerpMarketPda,
  type DriftMarket,
  type PerpMarketInfo,
} from '@/lib/drift/api';

const DriftChart = dynamic(() => import('./DriftChart'), {
  ssr: false,
  loading: () => (
    <div className="bg-[#131722] flex-1 flex items-center justify-center">
      <Loader2 size={20} className="animate-spin text-gray-500" />
    </div>
  ),
});

interface Props {
  vaultPda: string;
  leaderAddress: string;
  usdcReserve: number;
}

const DEFAULT_ORACLE_PRICE_USDC = 150_000_000; // $150 default for SOL

type CenterTab = 'positions' | 'orders';
type OrderType = 'market' | 'limit';

export default function MarginTradingPanel({ vaultPda, leaderAddress, usdcReserve }: Props) {
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();

  const [driftAccount, setDriftAccount] = useState<DriftUserAccountState | null | undefined>(undefined);
  const [position, setPosition] = useState<MarginPositionState | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [marketIndex, setMarketIndex] = useState(0);
  const [direction, setDirection] = useState<0 | 1>(0); // 0=Long, 1=Short
  const [collateral, setCollateral] = useState('');
  const [leverage, setLeverage] = useState('2');
  const [oraclePrice, setOraclePrice] = useState(String(DEFAULT_ORACLE_PRICE_USDC / 1e6));
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [centerTab, setCenterTab] = useState<CenterTab>('positions');
  const [marketSearch, setMarketSearch] = useState('');

  // Drift markets from Data API (or curated fallback)
  const [driftMarkets, setDriftMarkets] = useState<DriftMarket[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setMarketsLoading(true);
    fetchDriftMarkets()
      .then(list => { if (!cancelled) setDriftMarkets(list); })
      .finally(() => { if (!cancelled) setMarketsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Batch-check which markets are actually deployed on the current cluster.
  // Single getMultipleAccountsInfo call for all PerpMarket PDAs.
  // Map: marketIndex → true (deployed) | false (not deployed) | undefined (pending)
  const [marketAvailability, setMarketAvailability] = useState<Map<number, boolean>>(new Map());

  useEffect(() => {
    if (driftMarkets.length === 0) return;
    let cancelled = false;
    const pdas = driftMarkets.map(m => getPerpMarketPda(m.marketIndex));
    connection.getMultipleAccountsInfo(pdas)
      .then(accounts => {
        if (cancelled) return;
        const map = new Map<number, boolean>();
        driftMarkets.forEach((m, i) => map.set(m.marketIndex, !!accounts[i]));
        setMarketAvailability(map);
      })
      .catch(e => console.warn('[drift] PerpMarket batch lookup failed', e));
    return () => { cancelled = true; };
  }, [driftMarkets, connection]);

  // On-chain PerpMarket PDA + oracle for the selected market
  const [marketInfo, setMarketInfo] = useState<PerpMarketInfo | null>(null);
  const [marketInfoLoading, setMarketInfoLoading] = useState(false);
  const [marketInfoError, setMarketInfoError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMarketInfo(null);
    setMarketInfoError(null);
    setMarketInfoLoading(true);
    fetchPerpMarketInfo(connection, marketIndex)
      .then(info => {
        if (cancelled) return;
        if (info) setMarketInfo(info);
        else setMarketInfoError('PerpMarket account not found on-chain.');
      })
      .catch(e => {
        if (!cancelled) setMarketInfoError(e instanceof Error ? e.message.slice(0, 80) : 'lookup failed');
      })
      .finally(() => { if (!cancelled) setMarketInfoLoading(false); });
    return () => { cancelled = true; };
  }, [connection, marketIndex]);

  const isLeader = publicKey?.toBase58() === leaderAddress;
  const vaultPubkey = new PublicKey(vaultPda);

  function getProvider(): anchor.AnchorProvider {
    return new anchor.AnchorProvider(
      connection,
      { publicKey: publicKey!, signTransaction: signTransaction!, signAllTransactions: signAllTransactions! },
      { commitment: 'confirmed' },
    );
  }

  const refresh = useCallback(async () => {
    if (!publicKey) return;
    const provider = getProvider();
    const [da, pos] = await Promise.all([
      fetchDriftUserAccount(vaultPubkey, provider),
      fetchMarginPosition(vaultPubkey, marketIndex, provider),
    ]);
    setDriftAccount(da);
    setPosition(pos);
  }, [publicKey, vaultPda, marketIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refresh(); }, [refresh]);

  async function runTx(
    label: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    build: () => Promise<any>,
  ) {
    setLoading(true);
    setError(null);
    setStatus(`${label}...`);
    try {
      const builder = await build();
      const tx = await builder.rpc({ commitment: 'confirmed' });
      setStatus(`✅ ${label}: ${tx.slice(0, 16)}...`);
      await refresh();
    } catch (e: unknown) {
      const err = e as { message?: string; logs?: string[] };
      const logs = err.logs ?? [];
      const lastLog = logs.filter((l: string) => l.includes('Error') || l.includes('error')).slice(-2).join(' | ');
      setError(`${label} failed: ${err.message?.slice(0, 120) ?? 'unknown'}${lastLog ? ' — ' + lastLog : ''}`);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  const handleInitDrift = () => runTx('Init Drift account', () =>
    buildInitDriftAccountTx(getProvider(), vaultPubkey, publicKey!),
  );

  const handleOpen = () => {
    const col = parseFloat(collateral);
    const lev = parseFloat(leverage);
    const price = parseFloat(oraclePrice);
    if (!col || !lev || !price || col <= 0 || lev < 1 || lev > 10 || price <= 0) {
      setError('Invalid inputs. Collateral > 0, leverage 1–10x, oracle price > 0.');
      return;
    }
    const perpMarketPk = marketInfo ? new PublicKey(marketInfo.perpMarketPda) : undefined;
    const perpOraclePk = marketInfo ? new PublicKey(marketInfo.oracle) : undefined;
    runTx('Open margin position', () =>
      buildOpenMarginPositionTx(
        getProvider(),
        vaultPubkey,
        publicKey!,
        marketIndex,
        direction,
        new anchor.BN(Math.floor(col * 1e6)),
        new anchor.BN(Math.floor(lev * 10_000)),
        new anchor.BN(Math.floor(price * 1e6)),
        perpMarketPk,
        perpOraclePk,
      ),
    );
  };

  const handleClose = () => {
    const perpMarketPk = marketInfo ? new PublicKey(marketInfo.perpMarketPda) : undefined;
    const perpOraclePk = marketInfo ? new PublicKey(marketInfo.oracle) : undefined;
    runTx('Close margin position', () =>
      buildCloseMarginPositionTx(
        getProvider(), vaultPubkey, publicKey!, marketIndex,
        perpMarketPk, perpOraclePk,
      ),
    );
  };

  const handleWithdraw = () => {
    if (!position) return;
    const perpMarketPk = marketInfo ? new PublicKey(marketInfo.perpMarketPda) : undefined;
    const perpOraclePk = marketInfo ? new PublicKey(marketInfo.oracle) : undefined;
    runTx('Withdraw USDC from Drift', () =>
      buildWithdrawDriftUsdcTx(
        getProvider(),
        vaultPubkey,
        publicKey!,
        marketIndex,
        position.usdcCollateral,
        perpMarketPk,
        perpOraclePk,
      ),
    );
  };

  if (!isLeader) return null;

  // Tradeable iff we resolved the PerpMarket on-chain for the selected index.
  // The vault program accepts arbitrary perp_market + perp_oracle accounts, so
  // any market that exists on the current cluster can be traded.
  const fallbackMarket = PERP_MARKETS.find(m => m.index === marketIndex) ?? PERP_MARKETS[0];
  const selectedMarket =
    driftMarkets.find(m => m.marketIndex === marketIndex) ??
    {
      marketIndex: fallbackMarket.index,
      symbol: fallbackMarket.symbol,
      baseSymbol: fallbackMarket.symbol.replace(/-PERP$/, ''),
      isTradeable: true,
    };
  const isSelectedTradeable = !!marketInfo && !marketInfoError;

  const posOpen = position?.isOpen === true;
  const posPlacedClose = position && !position.isOpen && position.baseAssetAmount.gtn(0);
  const baseAmt = position ? position.baseAssetAmount.toNumber() / 1e9 : 0;
  const collateralUsdc = position ? position.usdcCollateral.toNumber() / 1e6 : 0;
  const [marginPosPda] = getMarginPositionPda(vaultPubkey, marketIndex);

  const filteredMarkets = driftMarkets.filter(m =>
    m.symbol.toLowerCase().includes(marketSearch.toLowerCase()) ||
    m.baseSymbol.toLowerCase().includes(marketSearch.toLowerCase()),
  );

  const notional = (parseFloat(collateral || '0') * parseFloat(leverage || '1'));
  const sizeInBase = parseFloat(oraclePrice || '0') > 0
    ? notional / parseFloat(oraclePrice || '1')
    : 0;
  const livePnl = posOpen && parseFloat(oraclePrice || '0') > 0
    ? (parseFloat(oraclePrice) - (collateralUsdc * parseFloat(leverage || '1') / (baseAmt || 1)))
        * baseAmt
        * (position!.direction === 0 ? 1 : -1)
    : 0;

  return (
    <div className="flex flex-col h-full bg-card">
      {/* ── Status bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-3 py-2 border-b border-border text-[10px] font-mono uppercase tracking-widest">
        <span className="text-purple-400 font-black">Drift Margin</span>
        <Sep />
        <span className="text-gray-500">
          Account:{' '}
          {driftAccount === undefined ? (
            <span className="text-gray-600 normal-case">loading…</span>
          ) : driftAccount ? (
            <span className="text-green-400">Initialized</span>
          ) : (
            <button
              onClick={handleInitDrift}
              disabled={loading}
              className="text-purple-400 hover:underline disabled:opacity-50 normal-case"
            >
              Initialize →
            </button>
          )}
        </span>
        <Sep />
        <span className="text-gray-500">
          Reserve: <span className="text-white">${usdcReserve.toFixed(2)}</span>
        </span>
        <Sep />
        <span className="text-gray-500">
          PDA:{' '}
          <a
            href={`https://explorer.solana.com/address/${marginPosPda.toBase58()}?cluster=${NETWORK}`}
            target="_blank"
            rel="noreferrer"
            className="text-gray-400 hover:text-purple-400"
          >
            {marginPosPda.toBase58().slice(0, 8)}…
            <ExternalLink size={9} className="inline ml-0.5" />
          </a>
        </span>
        <span className={`ml-auto px-2 py-0.5 ${
          NETWORK === 'devnet'
            ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30'
            : 'bg-green-500/10 text-green-400 border border-green-500/30'
        }`}>
          {NETWORK}
        </span>
      </div>

      {/* ── Main 3-column grid ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr_320px] gap-px bg-border flex-1 min-h-0">
        {/* ── Markets (left) ──────────────────────────────────────────── */}
        <aside className="bg-card flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">
              Markets
            </span>
            <span className="text-[10px] font-mono text-gray-600">
              {marketsLoading ? '…' : driftMarkets.length}
            </span>
          </div>

          <div className="px-2 pt-2 pb-1">
            <div className="relative flex items-center bg-black border border-border focus-within:border-purple-400/50">
              <Search size={11} className="absolute left-2 text-gray-500" />
              <input
                value={marketSearch}
                onChange={e => setMarketSearch(e.target.value)}
                placeholder="Search…"
                className="w-full bg-transparent pl-7 pr-2 py-1.5 text-[11px] font-mono text-white placeholder:text-gray-600 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-[1fr_auto_28px] gap-2 px-2 py-1 text-[9px] font-mono uppercase text-gray-600 border-b border-border">
            <span>Symbol</span>
            <span className="text-right">Status</span>
            <span className="text-right">#</span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {marketsLoading ? (
              <div className="px-2 py-4 text-[10px] text-gray-600 text-center flex items-center justify-center gap-1">
                <Loader2 size={10} className="animate-spin" /> loading…
              </div>
            ) : filteredMarkets.length === 0 ? (
              <div className="px-2 py-4 text-[10px] text-gray-600 text-center">
                No markets match.
              </div>
            ) : (
              filteredMarkets.map((m) => {
                const active = m.marketIndex === marketIndex;
                const deployed = marketAvailability.get(m.marketIndex);
                return (
                  <button
                    key={m.marketIndex}
                    onClick={() => setMarketIndex(m.marketIndex)}
                    className={`grid grid-cols-[1fr_auto_28px] gap-2 w-full px-2 py-2 text-[11px] font-mono items-center transition-colors ${
                      active
                        ? 'bg-purple-500/10 border-l-2 border-purple-400 text-white'
                        : 'border-l-2 border-transparent text-gray-400 hover:bg-white/5 hover:text-white'
                    }`}
                    title={
                      deployed === undefined
                        ? 'Resolving on-chain availability…'
                        : deployed
                        ? 'Deployed on this cluster — tradeable'
                        : `Not deployed on ${NETWORK}`
                    }
                  >
                    <span className="font-bold text-left truncate">{m.baseSymbol}</span>
                    <span className="text-right">
                      {deployed === undefined ? (
                        <Loader2 size={9} className="animate-spin text-gray-600 inline" />
                      ) : deployed ? (
                        <span className="text-[9px] font-bold text-green-400 bg-green-500/10 border border-green-500/30 px-1 py-px">
                          LIVE
                        </span>
                      ) : (
                        <Lock size={9} className="text-gray-600 inline" />
                      )}
                    </span>
                    <span className="text-right text-gray-500">{m.marketIndex}</span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* ── Chart + Positions (center) ──────────────────────────────── */}
        <div className="bg-card flex flex-col overflow-hidden min-w-0">
          <DriftChart symbol={selectedMarket.symbol} height={280} />

          {/* On-chain market info bar */}
          <MarketInfoBar
            symbol={selectedMarket.symbol}
            marketIndex={marketIndex}
            info={marketInfo}
            loading={marketInfoLoading}
            error={marketInfoError}
          />

          {/* Positions / Orders tabs */}
          <div className="border-t border-border">
            <div className="flex border-b border-border">
              <CenterTabBtn active={centerTab === 'positions'} onClick={() => setCenterTab('positions')}>
                Positions ({posOpen ? 1 : 0})
              </CenterTabBtn>
              <CenterTabBtn active={centerTab === 'orders'} onClick={() => setCenterTab('orders')}>
                Orders ({posPlacedClose ? 1 : 0})
              </CenterTabBtn>
            </div>

            <div className="overflow-y-auto max-h-[260px]">
              {centerTab === 'positions' && (
                <PositionsTable
                  marketSymbol={selectedMarket.symbol}
                  position={position}
                  baseAmt={baseAmt}
                  collateralUsdc={collateralUsdc}
                  oraclePrice={parseFloat(oraclePrice || '0')}
                  livePnl={livePnl}
                  loading={loading}
                  onClose={handleClose}
                  onWithdraw={handleWithdraw}
                />
              )}
              {centerTab === 'orders' && (
                <OrdersTable
                  marketSymbol={selectedMarket.symbol}
                  posPlacedClose={!!posPlacedClose}
                  baseAmt={baseAmt}
                  loading={loading}
                  onWithdraw={handleWithdraw}
                />
              )}
            </div>
          </div>

          {/* Status / error footer */}
          {(status || error) && (
            <div className="border-t border-border px-3 py-2 space-y-1 text-[10px] font-mono break-all">
              {status && <div className="text-green-400">{status}</div>}
              {error && <div className="text-red-400">{error}</div>}
            </div>
          )}
        </div>

        {/* ── Trade form (right) ──────────────────────────────────────── */}
        <aside className="bg-card flex flex-col overflow-y-auto">
          {/* Order type */}
          <div className="grid grid-cols-2 m-2 border border-border">
            <button
              onClick={() => setOrderType('market')}
              className={`py-2 text-[11px] font-black uppercase tracking-widest transition-colors ${
                orderType === 'market'
                  ? 'bg-purple-500 text-white'
                  : 'bg-black text-gray-500 hover:text-white'
              }`}
            >
              Market
            </button>
            <button
              disabled
              title="Limit orders not supported yet — Drift CPI uses immediate-or-cancel"
              className="py-2 text-[11px] font-black uppercase tracking-widest bg-black text-gray-700 cursor-not-allowed"
            >
              Limit
            </button>
          </div>

          {!isSelectedTradeable && !marketInfoLoading && (
            <div className="mx-3 mb-2 p-2 bg-yellow-500/10 border border-yellow-500/30 text-[10px] font-mono text-yellow-400 leading-relaxed flex items-start gap-2">
              <Lock size={11} className="mt-0.5 shrink-0" />
              <span>
                <span className="font-bold">{selectedMarket.symbol}</span>{' '}
                isn&apos;t deployed on the current cluster ({NETWORK}).
                Pick another market — see the on-chain info bar above the
                position table for the actual lookup result.
              </span>
            </div>
          )}

          {!driftAccount ? (
            <div className="px-3 py-4 text-center space-y-3">
              <p className="text-[11px] text-gray-400 font-mono">
                Initialize Drift account to start trading.
              </p>
              <button
                onClick={handleInitDrift}
                disabled={loading}
                className="w-full py-2.5 text-[11px] font-black uppercase tracking-widest bg-purple-500 hover:brightness-110 text-white disabled:opacity-50"
              >
                {loading ? 'Processing…' : 'Initialize Drift'}
              </button>
            </div>
          ) : (
            <div className="px-3 space-y-2">
              {/* Long / Short */}
              <div className="grid grid-cols-2 border border-border">
                <button
                  onClick={() => setDirection(0)}
                  className={`py-2.5 text-[11px] font-black uppercase tracking-widest transition-colors ${
                    direction === 0
                      ? 'bg-green-500 text-black'
                      : 'bg-black text-gray-500 hover:text-white'
                  }`}
                >
                  Long
                </button>
                <button
                  onClick={() => setDirection(1)}
                  className={`py-2.5 text-[11px] font-black uppercase tracking-widest transition-colors ${
                    direction === 1
                      ? 'bg-red-500 text-white'
                      : 'bg-black text-gray-500 hover:text-white'
                  }`}
                >
                  Short
                </button>
              </div>

              {/* Collateral */}
              <FormField
                label={`Collateral (USDC) — max $${usdcReserve.toFixed(2)}`}
                value={collateral}
                onChange={setCollateral}
                placeholder="0.00"
                suffix="USDC"
              />
              <div className="grid grid-cols-4 gap-1">
                {[10, 25, 50, 100].map(p => (
                  <button
                    key={p}
                    onClick={() => setCollateral(((usdcReserve * p) / 100).toFixed(2))}
                    className="py-1.5 bg-black border border-border text-[11px] font-bold text-gray-400 hover:text-purple-400 hover:border-purple-400/50 transition-colors"
                  >
                    {p}%
                  </button>
                ))}
              </div>

              {/* Leverage */}
              <div>
                <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest mb-1">
                  <span className="text-gray-500">Leverage</span>
                  <span className="text-white font-bold">{leverage}x</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="0.5"
                  value={leverage}
                  onChange={e => setLeverage(e.target.value)}
                  className="w-full accent-purple-500"
                />
                <div className="flex justify-between text-[10px] font-mono text-gray-600 mt-0.5">
                  <span>1x</span><span>5x</span><span>10x</span>
                </div>
              </div>

              {/* Oracle price */}
              <FormField
                label={`${selectedMarket.baseSymbol} Oracle Price${
                  NETWORK === 'devnet' ? ' (manual on devnet)' : ''
                }`}
                value={oraclePrice}
                onChange={setOraclePrice}
                placeholder="0.00"
                suffix="USD"
              />

              {/* Risk estimate */}
              <div className="bg-black/50 border border-border p-2 space-y-1 text-[10px] font-mono">
                <RiskRow label="Notional" value={`$${notional.toFixed(2)}`} accent="text-white" />
                <RiskRow
                  label="Size"
                  value={`${sizeInBase.toFixed(4)} ${selectedMarket.baseSymbol}`}
                  accent="text-white"
                />
                <RiskRow
                  label="Est. Liq Price"
                  value={
                    parseFloat(leverage) > 0
                      ? `$${(parseFloat(oraclePrice || '0') * (1 - (direction === 0 ? 1 : -1) * 0.9 / parseFloat(leverage))).toFixed(2)}`
                      : '—'
                  }
                  accent="text-orange-400"
                />
              </div>

              {/* Open — always available as long as vault has USDC */}
              <button
                onClick={handleOpen}
                disabled={loading || !collateral || !oraclePrice || !isSelectedTradeable || usdcReserve <= 0}
                className={`w-full py-3 text-[11px] font-black uppercase tracking-[0.3em] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all ${
                  direction === 0
                    ? 'bg-green-500 text-black hover:brightness-110'
                    : 'bg-red-500 text-white hover:brightness-110'
                }`}
              >
                {loading && <Loader2 size={13} className="animate-spin" />}
                {!isSelectedTradeable
                  ? 'Not supported'
                  : loading
                  ? '…'
                  : `Open ${direction === 0 ? 'Long' : 'Short'} ${leverage}x`}
              </button>

              {/* Secondary actions — coexist with Open so leader can manage position */}
              {posOpen && (
                <button
                  onClick={handleClose}
                  disabled={loading}
                  className="w-full py-2.5 text-[10px] font-black uppercase tracking-widest bg-red-700/80 hover:bg-red-600 text-white disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {loading && <Loader2 size={11} className="animate-spin" />}
                  Close Position
                </button>
              )}
              {posPlacedClose && (
                <button
                  onClick={handleWithdraw}
                  disabled={loading}
                  className="w-full py-2.5 text-[10px] font-black uppercase tracking-widest bg-blue-600/80 hover:bg-blue-500 text-white disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {loading && <Loader2 size={11} className="animate-spin" />}
                  Withdraw ${collateralUsdc.toFixed(2)}
                </button>
              )}
            </div>
          )}

          <div className="mt-auto px-3 pt-3 pb-3 border-t border-border text-[10px] font-mono text-gray-600 leading-relaxed">
            Margin trades execute via Drift CPI. Close orders need ~72s
            (180 slots) to fill before withdraw is available.
            {NETWORK === 'devnet' && (
              <span className="block mt-1 text-yellow-500">
                ⚠ Devnet oracle may be too stale for withdraw to succeed.
              </span>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function Sep() {
  return <span className="w-px h-3 bg-border" />;
}

function MarketInfoBar({
  symbol,
  marketIndex,
  info,
  loading,
  error,
}: {
  symbol: string;
  marketIndex: number;
  info: PerpMarketInfo | null;
  loading: boolean;
  error: string | null;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };
  const explorerCluster = NETWORK === 'devnet' ? '?cluster=devnet' : '';

  return (
    <div className="border-t border-b border-border bg-black/40 px-3 py-2 text-[10px] font-mono flex items-center gap-4 flex-wrap">
      <span className="text-gray-500 uppercase tracking-widest">
        On-Chain · #{marketIndex} {symbol}
      </span>

      {loading && (
        <span className="flex items-center gap-1 text-gray-600">
          <Loader2 size={9} className="animate-spin" /> resolving…
        </span>
      )}

      {error && !loading && (
        <span className="text-yellow-500">⚠ {error}</span>
      )}

      {info && !loading && (
        <>
          <AddrChip
            label="PerpMarket"
            value={info.perpMarketPda}
            copied={copied === 'perp'}
            onCopy={() => copy(info.perpMarketPda, 'perp')}
            href={`https://explorer.solana.com/address/${info.perpMarketPda}${explorerCluster}`}
          />
          <AddrChip
            label="Oracle"
            value={info.oracle}
            copied={copied === 'oracle'}
            onCopy={() => copy(info.oracle, 'oracle')}
            href={`https://explorer.solana.com/address/${info.oracle}${explorerCluster}`}
          />
        </>
      )}
    </div>
  );
}

function AddrChip({
  label,
  value,
  copied,
  onCopy,
  href,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  href: string;
}) {
  const short = `${value.slice(0, 6)}…${value.slice(-4)}`;
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-gray-500 uppercase">{label}:</span>
      <button
        onClick={onCopy}
        className="text-purple-400 hover:text-purple-300 underline-offset-2 hover:underline"
        title={value}
      >
        {short}
      </button>
      {copied && <span className="text-green-400">✓</span>}
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-gray-500 hover:text-purple-400"
        title="Open in explorer"
      >
        <ExternalLink size={9} />
      </a>
    </span>
  );
}

function CenterTabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest border-b-2 transition-colors ${
        active
          ? 'text-purple-400 border-purple-400'
          : 'text-gray-500 border-transparent hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  suffix: string;
}) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-gray-500 mb-1">
        {label}
      </div>
      <div className="relative flex items-center bg-black border border-border focus-within:border-purple-400/60">
        <input
          type="number"
          inputMode="decimal"
          step="any"
          min="0"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent px-3 py-2.5 text-base text-white font-mono font-bold focus:outline-none"
        />
        <span className="absolute right-3 text-[10px] font-mono font-bold text-gray-500 uppercase tracking-widest">
          {suffix}
        </span>
      </div>
    </div>
  );
}

function RiskRow({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={`font-bold ${accent}`}>{value}</span>
    </div>
  );
}

function PositionsTable({
  marketSymbol,
  position,
  baseAmt,
  collateralUsdc,
  oraclePrice,
  livePnl,
  loading,
  onClose,
  onWithdraw,
}: {
  marketSymbol: string;
  position: MarginPositionState | null | undefined;
  baseAmt: number;
  collateralUsdc: number;
  oraclePrice: number;
  livePnl: number;
  loading: boolean;
  onClose: () => void;
  onWithdraw: () => void;
}) {
  if (!position || (!position.isOpen && !position.baseAssetAmount.gtn(0))) {
    return (
      <div className="px-3 py-6 text-[11px] font-mono text-gray-600 text-center">
        No open positions.
      </div>
    );
  }

  const dirLabel = position.direction === 0 ? 'Long' : 'Short';
  const dirColor = position.direction === 0 ? 'text-green-400' : 'text-red-400';
  const isOpen = position.isOpen;
  const lev = collateralUsdc > 0 ? (baseAmt * oraclePrice) / collateralUsdc : 0;

  return (
    <div className="text-[11px] font-mono">
      <div className="grid grid-cols-[1fr_70px_90px_90px_70px_90px_120px] px-3 py-1.5 text-[9px] uppercase text-gray-600 border-b border-border">
        <span>Market</span>
        <span>Side</span>
        <span className="text-right">Size</span>
        <span className="text-right">Collateral</span>
        <span className="text-right">Lev</span>
        <span className="text-right">PnL</span>
        <span className="text-right">Action</span>
      </div>
      <div className="grid grid-cols-[1fr_70px_90px_90px_70px_90px_120px] px-3 py-2 items-center hover:bg-white/5">
        <span className="text-white font-bold">{marketSymbol}</span>
        <span className={`${dirColor} font-bold`}>
          {dirLabel}
          {!isOpen && <span className="text-yellow-400 ml-1">*</span>}
        </span>
        <span className="text-right text-white">{baseAmt.toFixed(4)}</span>
        <span className="text-right text-white">${collateralUsdc.toFixed(2)}</span>
        <span className="text-right text-white">{lev.toFixed(1)}x</span>
        <span className={`text-right font-bold ${livePnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {livePnl >= 0 ? '+' : ''}${livePnl.toFixed(2)}
        </span>
        <span className="text-right">
          {isOpen ? (
            <button
              onClick={onClose}
              disabled={loading}
              className="px-2 py-1 bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 text-[10px] font-bold uppercase disabled:opacity-50"
            >
              Close
            </button>
          ) : (
            <button
              onClick={onWithdraw}
              disabled={loading}
              className="px-2 py-1 bg-blue-500/20 border border-blue-500/40 text-blue-400 hover:bg-blue-500/30 text-[10px] font-bold uppercase disabled:opacity-50"
            >
              Withdraw
            </button>
          )}
        </span>
      </div>
      {!isOpen && (
        <div className="px-3 py-1.5 text-[10px] text-yellow-500 border-t border-border">
          * Close order placed — wait ~72s for fill, then withdraw.
        </div>
      )}
    </div>
  );
}

function OrdersTable({
  marketSymbol,
  posPlacedClose,
  baseAmt,
  loading,
  onWithdraw,
}: {
  marketSymbol: string;
  posPlacedClose: boolean;
  baseAmt: number;
  loading: boolean;
  onWithdraw: () => void;
}) {
  if (!posPlacedClose) {
    return (
      <div className="px-3 py-6 text-[11px] font-mono text-gray-600 text-center">
        No open orders.
      </div>
    );
  }
  return (
    <div className="text-[11px] font-mono">
      <div className="grid grid-cols-[1fr_80px_90px_120px_120px] px-3 py-1.5 text-[9px] uppercase text-gray-600 border-b border-border">
        <span>Market</span>
        <span>Type</span>
        <span className="text-right">Size</span>
        <span className="text-right">Status</span>
        <span className="text-right">Action</span>
      </div>
      <div className="grid grid-cols-[1fr_80px_90px_120px_120px] px-3 py-2 items-center hover:bg-white/5">
        <span className="text-white font-bold">{marketSymbol}</span>
        <span className="text-yellow-400 font-bold">Close (IOC)</span>
        <span className="text-right text-white">{baseAmt.toFixed(4)}</span>
        <span className="text-right text-yellow-400">Awaiting fill</span>
        <span className="text-right">
          <button
            onClick={onWithdraw}
            disabled={loading}
            className="px-2 py-1 bg-blue-500/20 border border-blue-500/40 text-blue-400 hover:bg-blue-500/30 text-[10px] font-bold uppercase disabled:opacity-50"
          >
            Withdraw
          </button>
        </span>
      </div>
    </div>
  );
}
