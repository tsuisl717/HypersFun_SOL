'use client';

/**
 * ConfirmationModal — pre-trade fee + amount breakdown.
 *
 * Solana port. The EVM `Approve USDC` step + allowance gating is removed
 * (Solana ATAs don't require approve). Caller passes already-computed
 * breakdowns; component is purely presentational.
 */

import React from 'react';
import type { VaultInfo, ExitFeeTier, UserExitFeeInfo } from './types';

export interface BuyBreakdown {
  inputAmount: number;
  tradingFeePercent: number;
  tradingFeeAmount: number;
  netAmount: number;
  tokensOut: number;
}

export interface SellBreakdown {
  tokens: number;
  grossAmount: number;
  exitFeePercent: number;
  exitFeeAmount: number;
  tradingFeePercent: number;
  tradingFeeAmount: number;
  netAmount: number;
  daysHeld: number;
  isLowLiquidity: boolean;
  availableLiquidity: number;
}

export interface ConfirmationModalProps {
  isOpen: boolean;
  mode: 'buy' | 'sell';
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
  vaultInfo: VaultInfo | null;
  buyBreakdown?: BuyBreakdown | null;
  sellBreakdown?: SellBreakdown | null;
  exitFeeTiers?: ExitFeeTier[];
  userExitFeeInfo?: UserExitFeeInfo | null;
}

export default function ConfirmationModal({
  isOpen,
  mode,
  onClose,
  onConfirm,
  loading,
  vaultInfo,
  buyBreakdown,
  sellBreakdown,
  exitFeeTiers = [],
  userExitFeeInfo,
}: ConfirmationModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl max-w-md w-full p-6 border border-border">
        {mode === 'buy' ? (
          // ─── BUY confirmation ────────────────────────────────────────
          <>
            <h3 className="text-xl font-bold mb-4 text-primary uppercase tracking-wider">
              Confirm Buy
            </h3>
            {buyBreakdown && (
              <div className="space-y-3">
                <div className="bg-black/40 border border-white/5 rounded-lg p-4 space-y-2">
                  <Row label="Input Amount" value={`$${buyBreakdown.inputAmount.toFixed(6)} USDC`} />
                  <Row
                    label={`Trading Fee (${buyBreakdown.tradingFeePercent}%)`}
                    value={`-$${buyBreakdown.tradingFeeAmount.toFixed(6)}`}
                    accent="text-yellow-400"
                  />
                  <hr className="border-gray-600" />
                  <Row label="Net Amount" value={`$${buyBreakdown.netAmount.toFixed(6)} USDC`} />
                  <Row
                    label="Est. Tokens"
                    value={`~${buyBreakdown.tokensOut.toFixed(6)} ${vaultInfo?.symbol ?? ''}`}
                    accent="text-green-400"
                  />
                </div>
              </div>
            )}
            <div className="flex gap-3 mt-6">
              <button
                onClick={onClose}
                className="flex-1 bg-black border border-border hover:bg-white/5 py-3 font-black uppercase tracking-widest text-sm transition-all"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={loading}
                className="flex-1 bg-primary hover:brightness-110 disabled:bg-gray-600 text-black py-3 font-black uppercase tracking-widest text-sm transition-all"
              >
                {loading ? 'Processing...' : 'Confirm Buy'}
              </button>
            </div>
          </>
        ) : (
          // ─── SELL confirmation ───────────────────────────────────────
          <>
            <h3 className="text-xl font-bold mb-4 text-red-400 uppercase tracking-wider">
              Confirm Sell
            </h3>
            {sellBreakdown && (
              <div className="space-y-3">
                {/* Exit fee tiers */}
                {exitFeeTiers.length > 0 && (
                  <div className="bg-black/40 border border-white/5 rounded-lg p-3">
                    <div className="text-xs text-gray-400 mb-2">Exit Fee Schedule</div>
                    <div className="grid grid-cols-2 gap-1 text-xs">
                      {exitFeeTiers.map((tier, i) => {
                        const nextTier = exitFeeTiers[i + 1];
                        const isActive =
                          userExitFeeInfo &&
                          userExitFeeInfo.daysHeld >= tier.daysHeld &&
                          (!nextTier || userExitFeeInfo.daysHeld < nextTier.daysHeld);
                        return (
                          <div
                            key={i}
                            className={`flex justify-between p-1 rounded ${
                              isActive ? 'bg-yellow-600/30 text-yellow-400' : ''
                            }`}
                          >
                            <span>
                              {tier.daysHeld === 0
                                ? '< 7'
                                : tier.daysHeld === 7
                                ? '7-30'
                                : tier.daysHeld === 30
                                ? '30-90'
                                : '> 90'}{' '}
                              days
                            </span>
                            <span>{tier.feeBps / 100}%</span>
                          </div>
                        );
                      })}
                    </div>
                    {userExitFeeInfo && (
                      <div className="mt-2 text-sm text-yellow-400 font-semibold">
                        Your fee: {userExitFeeInfo.currentFeeBps / 100}% (
                        {userExitFeeInfo.daysHeld} days held)
                      </div>
                    )}
                  </div>
                )}

                {/* Fee breakdown */}
                <div className="bg-black/40 border border-white/5 rounded-lg p-4 space-y-2">
                  <Row
                    label="Tokens to Sell"
                    value={`${sellBreakdown.tokens.toFixed(4)} ${vaultInfo?.symbol ?? ''}`}
                  />
                  <Row label="Gross Amount" value={`$${sellBreakdown.grossAmount.toFixed(4)}`} />
                  <Row
                    label={`Exit Fee (${sellBreakdown.exitFeePercent}%)`}
                    value={`-$${sellBreakdown.exitFeeAmount.toFixed(4)}`}
                    accent="text-orange-400"
                  />
                  <Row
                    label={`Trading Fee (${sellBreakdown.tradingFeePercent}%)`}
                    value={`-$${sellBreakdown.tradingFeeAmount.toFixed(4)}`}
                    accent="text-yellow-400"
                  />
                  <hr className="border-gray-600" />
                  <Row
                    label="You Receive"
                    value={`$${sellBreakdown.netAmount.toFixed(4)} USDC`}
                    accent="text-green-400"
                    bold
                  />
                  {sellBreakdown.isLowLiquidity && (
                    <div className="text-xs text-yellow-400 bg-yellow-900/30 p-2 rounded">
                      ⚠ Low liquidity (${sellBreakdown.availableLiquidity.toFixed(2)} available)
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="flex gap-3 mt-6">
              <button
                onClick={onClose}
                className="flex-1 bg-black border border-border hover:bg-white/5 py-3 font-black uppercase tracking-widest text-sm transition-all"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={loading}
                className="flex-1 bg-red-500 hover:brightness-110 disabled:bg-gray-600 text-white py-3 font-black uppercase tracking-widest text-sm transition-all"
              >
                {loading ? 'Processing...' : 'Confirm Sell'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  accent,
  bold,
}: {
  label: string;
  value: string;
  accent?: string;
  bold?: boolean;
}) {
  return (
    <div className={`flex justify-between text-sm ${bold ? 'font-semibold' : ''}`}>
      <span className={accent ?? 'text-gray-400'}>{label}</span>
      <span className={`font-mono ${accent ?? ''}`}>{value}</span>
    </div>
  );
}
