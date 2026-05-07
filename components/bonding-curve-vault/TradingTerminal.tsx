'use client';

/**
 * TradingTerminal — Buy/Sell rail.
 *
 * Solana-port of HyperVapor's TradingTerminal. Same prop shape so the
 * caller can swap implementations easily, but EVM-specific concepts
 * (bridge / approve / pending-sell two-step / Hyperliquid L1 reserve
 * split) are removed.
 *
 * Sections:
 *   • BUY / SELL toggle
 *   • Amount input + 10/25/50/100% presets
 *   • Action button (Buy or Sell)
 *   • Status message
 *   • Reserve breakdown (USDC / External / Total)
 *   • Social links
 *   • NAV stabilisation block
 *   • Graduation tiers table
 */

import { useState } from 'react';
import { Loader2, ExternalLink, Globe, Send } from 'lucide-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

import { getExplorerUrl } from '@/lib/contracts/config';
import type {
  VaultInfo,
  BondingCurveInfo,
  ReserveStatus,
  UserExitFeeInfo,
  ExitFeeConfig,
  ExitFeeTier,
  GraduationTier,
} from './types';

export interface TradingTerminalProps {
  vaultInfo: VaultInfo;
  bcInfo: BondingCurveInfo | null;
  reserveStatus: ReserveStatus | null;
  userBalance: string;        // human vault token balance
  userUsdcBalance: string;    // human USDC balance
  minDepositUsdc?: string;
  isConnected: boolean;
  isLeader: boolean;
  isAdmin?: boolean;
  loading: boolean;
  status?: string;
  setStatus?: (status: string) => void;
  /** TODO(solana): wire from Anchor program account if exit-fee tiers are added */
  userExitFeeInfo?: UserExitFeeInfo | null;
  exitFeeConfig?: ExitFeeConfig | null;
  exitFeeTiers?: ExitFeeTier[];
  graduationTiers?: GraduationTier[];
  totalAssets?: number;
  /** Most recent transaction signature, for explorer link in status banner */
  lastTxSignature?: string;
  onBuy: (amount: string) => Promise<void> | void;
  onSell: (amount: string) => Promise<void> | void;
  onRefresh?: () => void;
  /** Estimate output tokens for a given USDC input — caller computes from BC */
  getExpectedTokens: (usdcAmount: string) => string;
  /** Estimate output USDC for a given token input */
  getExpectedUsdc: (tokenAmount: string) => string;
  links?: VaultInfo['links'];
}

export default function TradingTerminal({
  vaultInfo,
  bcInfo: _bcInfo,
  reserveStatus,
  userBalance,
  userUsdcBalance,
  minDepositUsdc = '5',
  isConnected,
  isLeader: _isLeader,
  isAdmin: _isAdmin,
  loading,
  status,
  userExitFeeInfo: _userExitFeeInfo,
  exitFeeConfig: _exitFeeConfig,
  exitFeeTiers: _exitFeeTiers,
  graduationTiers = [],
  totalAssets = 0,
  lastTxSignature,
  onBuy,
  onSell,
  onRefresh: _onRefresh,
  getExpectedTokens,
  getExpectedUsdc,
  links,
}: TradingTerminalProps) {
  const [tradeType, setTradeType] = useState<'buy' | 'sell'>('buy');
  const [buyAmount, setBuyAmount] = useState('');
  const [sellAmount, setSellAmount] = useState('');

  const balance = tradeType === 'buy' ? userUsdcBalance : userBalance;
  const balanceLabel = tradeType === 'buy' ? 'USDC' : vaultInfo.symbol;
  const inputValue = tradeType === 'buy' ? buyAmount : sellAmount;
  const setInput = tradeType === 'buy' ? setBuyAmount : setSellAmount;

  const setPercent = (pct: number) => {
    const bal = parseFloat(balance) || 0;
    const next = ((bal * pct) / 100).toFixed(tradeType === 'buy' ? 2 : 4);
    setInput(next);
  };

  const handleSubmit = async () => {
    if (!inputValue) return;
    if (tradeType === 'buy') await onBuy(buyAmount);
    else await onSell(sellAmount);
  };

  const tier = pickCurrentTier(totalAssets, graduationTiers);

  return (
    <div className="flex flex-col">
      {/* BUY / SELL toggle */}
      <div className="grid grid-cols-2 m-2 border border-border">
        <button
          onClick={() => setTradeType('buy')}
          className={`py-2.5 text-xs font-black uppercase tracking-widest transition-colors ${
            tradeType === 'buy' ? 'bg-primary text-black' : 'bg-black text-gray-500 hover:text-white'
          }`}
        >
          Buy
        </button>
        <button
          onClick={() => setTradeType('sell')}
          className={`py-2.5 text-xs font-black uppercase tracking-widest transition-colors ${
            tradeType === 'sell' ? 'bg-red-500 text-white' : 'bg-black text-gray-500 hover:text-white'
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
            Bal:{' '}
            <span className="text-gray-300">
              {parseFloat(balance || '0').toFixed(tradeType === 'buy' ? 2 : 4)}
            </span>
          </span>
        </div>
        <div className="relative flex items-center bg-black border border-border focus-within:border-primary transition-colors">
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={inputValue}
            onChange={(e) => setInput(e.target.value)}
            placeholder={tradeType === 'buy' ? `Min ${minDepositUsdc}` : '0.00'}
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
              className="py-1.5 bg-black border border-border text-[11px] font-bold text-gray-400 hover:text-primary hover:border-primary/50 disabled:opacity-40 transition-colors"
            >
              {p}%
            </button>
          ))}
        </div>

        {/* Expected output */}
        {tradeType === 'buy' && buyAmount && (
          <div className="text-[11px] font-mono text-gray-400">
            ≈ <span className="text-primary">{getExpectedTokens(buyAmount)} {vaultInfo.symbol}</span>
          </div>
        )}
        {tradeType === 'sell' && sellAmount && (
          <div className="text-[11px] font-mono text-gray-400">
            ≈ <span className="text-red-400">${getExpectedUsdc(sellAmount)} USDC</span>
          </div>
        )}

        {/* Action button */}
        {!isConnected ? (
          <WalletMultiButton style={{ width: '100%', justifyContent: 'center' }} />
        ) : (
          <button
            onClick={handleSubmit}
            disabled={loading || !inputValue}
            className={`w-full py-3 text-xs font-black uppercase tracking-[0.3em] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all ${
              tradeType === 'buy'
                ? 'bg-primary text-black hover:brightness-110'
                : 'bg-red-500 text-white hover:brightness-110'
            }`}
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? '...' : tradeType.toUpperCase()}
          </button>
        )}

        {/* Status message */}
        {status && (
          <div
            className={`px-2 py-1.5 text-[11px] font-mono break-all border ${
              status.toLowerCase().includes('error') || status.toLowerCase().includes('fail')
                ? 'border-red-500/40 bg-red-500/5 text-red-400'
                : status.toLowerCase().includes('success') || status.toLowerCase().includes('confirmed')
                ? 'border-lime-500/40 bg-lime-500/5 text-lime-400'
                : 'border-yellow-500/40 bg-yellow-500/5 text-yellow-400'
            }`}
          >
            <div>{status}</div>
            {lastTxSignature && (
              <a
                href={getExplorerUrl('tx', lastTxSignature)}
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
      {reserveStatus && (
        <div className="mt-3 px-3 pt-3 border-t border-border">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-black uppercase tracking-widest text-gray-500">
              Reserve
            </div>
            {reserveStatus.isLiquidityCapped && (
              <span className="text-[10px] font-bold text-red-400 bg-red-500/10 px-2 py-0.5 border border-red-500/30 uppercase tracking-wider">
                Low Liq
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1.5 font-mono text-sm">
            <ReserveCell label="USDC" value={`$${parseFloat(reserveStatus.usdcReserve || '0').toFixed(2)}`} />
            <ReserveCell label="External" value={`$${parseFloat(reserveStatus.externalAssets || '0').toFixed(2)}`} />
            <ReserveCell
              label="Total"
              value={`$${parseFloat(reserveStatus.totalAssets || '0').toFixed(2)}`}
              accent="text-primary"
            />
          </div>
        </div>
      )}

      {/* Social links */}
      {(links?.website || links?.twitter || links?.telegram) && (
        <div className="mt-3 px-3 pt-3 border-t border-border">
          <div className="text-xs font-black uppercase tracking-widest text-gray-500 mb-2">
            Social Links
          </div>
          <div className="flex gap-2">
            {links?.website && (
              <SocialIcon href={links.website} icon={<Globe size={16} />} />
            )}
            {links?.twitter && (
              <SocialIcon
                href={links.twitter}
                icon={<span className="text-[12px] font-black">𝕏</span>}
              />
            )}
            {links?.telegram && (
              <SocialIcon href={links.telegram} icon={<Send size={16} />} />
            )}
          </div>
        </div>
      )}

      {/* NAV stabilisation */}
      <div className="mt-3 px-3 pt-3 border-t border-border">
        <div className="text-xs font-black uppercase tracking-widest text-gray-500 mb-2">
          NAV Stabilization
        </div>
        <div className="grid grid-cols-2 gap-1.5 mb-2">
          <NavCell label="Assets" value={formatNum(totalAssets)} accent="text-white" />
          <NavCell
            label="Supply"
            value={formatNum(parseFloat(vaultInfo.totalSupply || '0'))}
            accent="text-white"
          />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <NavCell label="Raw NAV" value={`$${parseFloat(vaultInfo.rawNav || '0').toFixed(4)}`} accent="text-yellow-400" />
          <NavCell label="Stab NAV" value={`$${parseFloat(vaultInfo.stabNav || vaultInfo.nav || '0').toFixed(4)}`} accent="text-orange-400" />
          <NavCell label="TWAP" value={`$${parseFloat(vaultInfo.nav || '0').toFixed(4)}`} accent="text-primary" />
        </div>
      </div>

      {/* Graduation tiers */}
      {graduationTiers.length > 0 && (
        <div className="mt-3 px-3 pt-3 pb-4 border-t border-border">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-black uppercase tracking-widest text-gray-500">
              Graduation Tiers
            </div>
            <div className="text-[10px] font-mono text-green-400">
              ✓ {graduationTiers.length} tiers
            </div>
          </div>
          <div className="text-[10px]">
            <div className="grid grid-cols-5 px-1 py-1 text-gray-500 border-b border-border font-bold">
              <div>Tier</div>
              <div className="text-right">Threshold</div>
              <div className="text-right">BC</div>
              <div className="text-right">NAV Mul</div>
              <div className="text-right">Sq²</div>
            </div>
            {graduationTiers.map((t, i) => {
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
                    {((t.squaredRatioBps ?? 0) / 100).toFixed(0)}%
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function ReserveCell({
  label,
  value,
  accent,
}: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-black/40 border border-white/5 p-1.5">
      <div className="text-gray-500 uppercase text-[10px] font-bold tracking-widest">
        {label}
      </div>
      <div className={`font-mono font-bold text-sm ${accent ?? 'text-white'}`}>
        {value}
      </div>
    </div>
  );
}

function NavCell({
  label,
  value,
  accent,
}: { label: string; value: string; accent: string }) {
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

function pickCurrentTier(
  totalAssets: number,
  tiers: GraduationTier[],
): GraduationTier | null {
  if (tiers.length === 0) return null;
  for (const t of tiers) {
    if (totalAssets < t.threshold) return t;
  }
  return tiers[tiers.length - 1];
}

function formatNum(n: number): string {
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  if (Math.abs(n) >= 1) return n.toFixed(0);
  if (n > 0) return n.toFixed(2);
  return '0';
}
