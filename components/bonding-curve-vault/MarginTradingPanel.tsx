'use client';

/**
 * MarginTradingPanel — Leader-only panel for Drift Protocol CPI margin trading.
 *
 * Flow:
 *   1. Init Drift account (one-time)
 *   2. Open position (deposit USDC → place_perp_order)
 *   3. Close position (reverse reduce_only order)
 *   4. Withdraw USDC (after close order fills)
 *
 * Devnet note: withdraw may fail due to stale oracle (67k+ slot delay on
 * vELoC1 devnet). This is a devnet limitation, not a code issue.
 */

import { useState, useEffect, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
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

interface Props {
  vaultPda: string;
  leaderAddress: string;
  usdcReserve: number;   // human-readable USDC
}

// Approximate SOL oracle price for opening (µUSDC/SOL)
// On devnet oracle is stale — user should input current price manually
const DEFAULT_ORACLE_PRICE_USDC = 150_000_000; // $150 default

export default function MarginTradingPanel({ vaultPda, leaderAddress, usdcReserve }: Props) {
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();

  const [driftAccount, setDriftAccount] = useState<DriftUserAccountState | null | undefined>(undefined);
  const [position, setPosition] = useState<MarginPositionState | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [marketIndex] = useState(0); // SOL-PERP only for now
  const [direction, setDirection] = useState<0 | 1>(0); // 0=Long, 1=Short
  const [collateral, setCollateral] = useState('');
  const [leverage, setLeverage] = useState('2');
  const [oraclePrice, setOraclePrice] = useState(String(DEFAULT_ORACLE_PRICE_USDC / 1e6));

  const isLeader = publicKey?.toBase58() === leaderAddress;
  const vaultPubkey = new PublicKey(vaultPda);

  function getProvider(): anchor.AnchorProvider {
    return new anchor.AnchorProvider(
      connection,
      { publicKey: publicKey!, signTransaction: signTransaction!, signAllTransactions: signAllTransactions! },
      { commitment: 'confirmed' }
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
    build: () => Promise<any>
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
    buildInitDriftAccountTx(getProvider(), vaultPubkey, publicKey!)
  );

  const handleOpen = () => {
    const col = parseFloat(collateral);
    const lev = parseFloat(leverage);
    const price = parseFloat(oraclePrice);
    if (!col || !lev || !price || col <= 0 || lev < 1 || lev > 10 || price <= 0) {
      setError('Invalid inputs. Collateral > 0, leverage 1–10x, oracle price > 0.');
      return;
    }
    runTx('Open margin position', () =>
      buildOpenMarginPositionTx(
        getProvider(),
        vaultPubkey,
        publicKey!,
        marketIndex,
        direction,
        new anchor.BN(Math.floor(col * 1e6)),        // µUSDC
        new anchor.BN(Math.floor(lev * 10_000)),     // BPS (10000 = 1x)
        new anchor.BN(Math.floor(price * 1e6))       // µUSDC/token
      )
    );
  };

  const handleClose = () => runTx('Close margin position', () =>
    buildCloseMarginPositionTx(getProvider(), vaultPubkey, publicKey!, marketIndex)
  );

  const handleWithdraw = () => {
    if (!position) return;
    runTx('Withdraw USDC from Drift', () =>
      buildWithdrawDriftUsdcTx(
        getProvider(),
        vaultPubkey,
        publicKey!,
        marketIndex,
        position.usdcCollateral
      )
    );
  };

  if (!isLeader) return null;

  const market = PERP_MARKETS[marketIndex];
  const posOpen = position?.isOpen === true;
  const posPlacedClose = position && !position.isOpen && position.baseAssetAmount.gtn(0);
  const baseAmt = position ? position.baseAssetAmount.toNumber() / 1e9 : 0;
  const collateralUsdc = position ? position.usdcCollateral.toNumber() / 1e6 : 0;
  const [marginPosPda] = getMarginPositionPda(vaultPubkey, marketIndex);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Drift Margin Trading</h3>
        <span className="text-[10px] text-gray-500 uppercase tracking-wider">
          {NETWORK === 'devnet' ? 'Devnet' : 'Mainnet'}
        </span>
      </div>

      {/* Drift account status */}
      <div className="bg-[#0d1117] rounded-lg p-3 space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-gray-500">Drift Account</span>
          {driftAccount === undefined ? (
            <span className="text-gray-600">loading...</span>
          ) : driftAccount ? (
            <span className="text-green-400">Initialized</span>
          ) : (
            <button
              onClick={handleInitDrift}
              disabled={loading}
              className="text-[var(--primary)] hover:underline disabled:opacity-50"
            >
              Initialize →
            </button>
          )}
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Vault USDC Reserve</span>
          <span className="text-white">${usdcReserve.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Position PDA</span>
          <a
            href={`https://explorer.solana.com/address/${marginPosPda.toBase58()}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="text-gray-600 hover:text-gray-400 font-mono text-[10px]"
          >
            {marginPosPda.toBase58().slice(0, 8)}…
          </a>
        </div>
      </div>

      {/* Current position */}
      {position && (
        <div className={`rounded-lg p-3 text-xs space-y-1 border ${
          posOpen ? 'bg-green-900/20 border-green-800' : 'bg-yellow-900/20 border-yellow-800'
        }`}>
          <div className="flex items-center justify-between">
            <span className="font-semibold text-white">{market.symbol} Position</span>
            <span className={posOpen ? 'text-green-400' : 'text-yellow-400'}>
              {posOpen ? 'Open' : posPlacedClose ? 'Close order placed' : 'Closed'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Direction</span>
            <span className={position.direction === 0 ? 'text-green-400' : 'text-red-400'}>
              {position.direction === 0 ? 'Long' : 'Short'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Size</span>
            <span className="text-white">{baseAmt.toFixed(4)} SOL</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Collateral</span>
            <span className="text-white">${collateralUsdc.toFixed(2)}</span>
          </div>
          {posOpen && (
            <div className="flex justify-between">
              <span className="text-gray-500">Leverage</span>
              <span className="text-white">
                ~{(baseAmt * parseFloat(oraclePrice) / collateralUsdc).toFixed(1)}x
              </span>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      {driftAccount && (
        <div className="space-y-3">
          {/* Open position form */}
          {!posOpen && !posPlacedClose && (
            <div className="bg-[#0d1117] rounded-lg p-3 space-y-3">
              <p className="text-xs font-semibold text-white">Open Position</p>

              {/* Long / Short toggle */}
              <div className="flex rounded overflow-hidden text-xs">
                <button
                  onClick={() => setDirection(0)}
                  className={`flex-1 py-1.5 font-semibold transition-colors ${
                    direction === 0 ? 'bg-green-600 text-white' : 'bg-[#1a1f2e] text-gray-400'
                  }`}
                >Long</button>
                <button
                  onClick={() => setDirection(1)}
                  className={`flex-1 py-1.5 font-semibold transition-colors ${
                    direction === 1 ? 'bg-red-600 text-white' : 'bg-[#1a1f2e] text-gray-400'
                  }`}
                >Short</button>
              </div>

              {/* Market */}
              <div>
                <label className="text-[10px] text-gray-500 block mb-1">Market</label>
                <div className="bg-[#1a1f2e] rounded px-3 py-2 text-xs text-white">{market.symbol}</div>
              </div>

              {/* Collateral */}
              <div>
                <label className="text-[10px] text-gray-500 block mb-1">
                  Collateral (USDC) — max ${usdcReserve.toFixed(2)}
                </label>
                <input
                  type="number"
                  value={collateral}
                  onChange={e => setCollateral(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-[#1a1f2e] rounded px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-[var(--primary)]"
                />
              </div>

              {/* Leverage */}
              <div>
                <label className="text-[10px] text-gray-500 block mb-1">
                  Leverage: {leverage}x
                </label>
                <input
                  type="range"
                  min="1" max="10" step="0.5"
                  value={leverage}
                  onChange={e => setLeverage(e.target.value)}
                  className="w-full accent-[var(--primary)]"
                />
                <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
                  <span>1x</span><span>5x</span><span>10x</span>
                </div>
              </div>

              {/* Oracle price */}
              <div>
                <label className="text-[10px] text-gray-500 block mb-1">
                  SOL Oracle Price (USD)
                  {NETWORK === 'devnet' && (
                    <span className="ml-1 text-yellow-500">⚠ Enter current price manually</span>
                  )}
                </label>
                <input
                  type="number"
                  value={oraclePrice}
                  onChange={e => setOraclePrice(e.target.value)}
                  placeholder="150"
                  className="w-full bg-[#1a1f2e] rounded px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-[var(--primary)]"
                />
              </div>

              {/* Position summary */}
              {collateral && oraclePrice && leverage && (
                <div className="bg-[#1a1f2e] rounded p-2 text-[10px] text-gray-400 space-y-0.5">
                  <div className="flex justify-between">
                    <span>Notional</span>
                    <span className="text-white">
                      ${(parseFloat(collateral || '0') * parseFloat(leverage || '1')).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>SOL size</span>
                    <span className="text-white">
                      {(parseFloat(collateral || '0') * parseFloat(leverage || '1') / parseFloat(oraclePrice || '1')).toFixed(4)} SOL
                    </span>
                  </div>
                </div>
              )}

              <button
                onClick={handleOpen}
                disabled={loading || !collateral || !oraclePrice}
                className={`w-full py-2 rounded text-xs font-semibold transition-colors disabled:opacity-50 ${
                  direction === 0
                    ? 'bg-green-600 hover:bg-green-500 text-white'
                    : 'bg-red-600 hover:bg-red-500 text-white'
                }`}
              >
                {loading ? 'Processing...' : `Open ${direction === 0 ? 'Long' : 'Short'} ${leverage}x`}
              </button>
            </div>
          )}

          {/* Close / Withdraw buttons */}
          {posOpen && (
            <button
              onClick={handleClose}
              disabled={loading}
              className="w-full py-2 rounded text-xs font-semibold bg-red-700 hover:bg-red-600 text-white disabled:opacity-50"
            >
              {loading ? 'Processing...' : 'Close Position (Place Reverse Order)'}
            </button>
          )}

          {posPlacedClose && (
            <div className="space-y-2">
              <div className="bg-yellow-900/20 border border-yellow-800 rounded p-2 text-[10px] text-yellow-400">
                Close order placed. Wait for Drift to fill it (up to 180 slots ~72s),
                then click Withdraw.
                {NETWORK === 'devnet' && (
                  <span className="block mt-1 text-yellow-600">
                    ⚠ Devnet: oracle may be too stale for withdraw to succeed.
                  </span>
                )}
              </div>
              <button
                onClick={handleWithdraw}
                disabled={loading}
                className="w-full py-2 rounded text-xs font-semibold bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50"
              >
                {loading ? 'Processing...' : `Withdraw $${collateralUsdc.toFixed(2)} USDC`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Status / Error */}
      {status && (
        <div className="text-[10px] text-green-400 bg-green-900/20 rounded p-2 break-all">{status}</div>
      )}
      {error && (
        <div className="text-[10px] text-red-400 bg-red-900/20 rounded p-2 break-all">{error}</div>
      )}
    </div>
  );
}
