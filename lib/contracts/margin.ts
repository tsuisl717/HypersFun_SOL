/**
 * Margin trading helpers for HypersFun + Drift Protocol CPI
 * Program: 5jmoeSiY3kyFhaipuiV1Six4sAwMetsEWNNCTBdfrEza (devnet)
 */

import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as anchor from '@coral-xyz/anchor';
import { PROGRAM_ID, DRIFT_CONFIG, USDC_MINT } from './config';
import IDL from './hypersfun-idl.json';

// ─── PDAs ────────────────────────────────────────────────────────────────────

export function getVaultPda(tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), tokenMint.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

export function getUsdcVaultPda(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('usdc_vault'), vault.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

export function getMarginPositionPda(vault: PublicKey, marketIndex: number): [PublicKey, number] {
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(marketIndex, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('margin'), vault.toBuffer(), idx],
    new PublicKey(PROGRAM_ID)
  );
}

export function getDriftUserAccountPda(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('drift_account'), vault.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

export function getDriftUserPda(vault: PublicKey, subAccountId = 0): [PublicKey, number] {
  const sub = Buffer.alloc(2);
  sub.writeUInt16LE(subAccountId, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user'), vault.toBuffer(), sub],
    new PublicKey(DRIFT_CONFIG.programId)
  );
}

export function getDriftUserStatsPda(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_stats'), vault.toBuffer()],
    new PublicKey(DRIFT_CONFIG.programId)
  );
}

export function getUserSharePda(vault: PublicKey, user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('share'), vault.toBuffer(), user.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

// ─── Program factory ─────────────────────────────────────────────────────────

export function getProgram(provider: anchor.AnchorProvider): anchor.Program {
  return new anchor.Program(IDL as anchor.Idl, provider);
}

// ─── Account fetchers ────────────────────────────────────────────────────────

export interface VaultState {
  leader: PublicKey;
  tokenMint: PublicKey;
  usdcReserve: anchor.BN;
  externalAssets: anchor.BN;
  totalSupply: anchor.BN;
  bump: number;
  usdcVaultBump: number;
  isPaused: boolean;
}

export interface MarginPositionState {
  vault: PublicKey;
  leader: PublicKey;
  marketIndex: number;
  direction: number;
  baseAssetAmount: anchor.BN;
  usdcCollateral: anchor.BN;
  entryPrice: anchor.BN;
  orderId: number;
  isOpen: boolean;
  bump: number;
}

export interface DriftUserAccountState {
  vault: PublicKey;
  driftUser: PublicKey;
  totalDeposited: anchor.BN;
  subAccountId: number;
  bump: number;
}

export async function fetchVaultState(
  connection: Connection,
  vaultPda: PublicKey,
  provider: anchor.AnchorProvider
): Promise<VaultState | null> {
  try {
    const program = getProgram(provider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (program.account as any).vault.fetch(vaultPda) as VaultState;
  } catch {
    return null;
  }
}

export async function fetchMarginPosition(
  vaultPda: PublicKey,
  marketIndex: number,
  provider: anchor.AnchorProvider
): Promise<MarginPositionState | null> {
  try {
    const program = getProgram(provider);
    const [pda] = getMarginPositionPda(vaultPda, marketIndex);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (program.account as any).marginPosition.fetch(pda) as MarginPositionState;
  } catch {
    return null;
  }
}

export async function fetchDriftUserAccount(
  vaultPda: PublicKey,
  provider: anchor.AnchorProvider
): Promise<DriftUserAccountState | null> {
  try {
    const program = getProgram(provider);
    const [pda] = getDriftUserAccountPda(vaultPda);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (program.account as any).driftUserAccount.fetch(pda) as DriftUserAccountState;
  } catch {
    return null;
  }
}

// ─── Market config ───────────────────────────────────────────────────────────

export const PERP_MARKETS = [
  {
    index: 0,
    symbol: 'SOL-PERP',
    perpMarket: DRIFT_CONFIG.solPerpMarket,
    oracle: DRIFT_CONFIG.solOracle,
  },
];

export function getPerpMarket(marketIndex: number) {
  return PERP_MARKETS.find(m => m.index === marketIndex) ?? PERP_MARKETS[0];
}

// ─── Transaction builders ────────────────────────────────────────────────────

/** Initialize Drift account for vault (one-time) */
export async function buildInitDriftAccountTx(
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
  leader: PublicKey
) {
  const program = getProgram(provider);
  const [driftUserAccountPda] = getDriftUserAccountPda(vaultPda);
  const [driftUserPda] = getDriftUserPda(vaultPda);
  const [driftUserStatsPda] = getDriftUserStatsPda(vaultPda);

  return program.methods.initDriftAccount().accounts({
    vault: vaultPda,
    driftUserAccount: driftUserAccountPda,
    driftUser: driftUserPda,
    driftUserStats: driftUserStatsPda,
    driftState: new PublicKey(DRIFT_CONFIG.state),
    driftProgram: new PublicKey(DRIFT_CONFIG.programId),
    leader,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  });
}

/**
 * Open a margin position on Drift via CPI
 * @param oraclePriceUsdc - current oracle price in µUSDC (e.g. 150_000_000 for $150)
 */
export async function buildOpenMarginPositionTx(
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
  leader: PublicKey,
  marketIndex: number,
  direction: 0 | 1,   // 0=Long, 1=Short
  usdcCollateral: anchor.BN,  // in µUSDC (6 decimals)
  leverageBps: anchor.BN,     // e.g. 20000 = 2x
  oraclePriceUsdc: anchor.BN  // in µUSDC/token
) {
  const program = getProgram(provider);
  const market = getPerpMarket(marketIndex);
  const [usdcVaultPda] = getUsdcVaultPda(vaultPda);
  const [marginPosPda] = getMarginPositionPda(vaultPda, marketIndex);
  const [driftUserPda] = getDriftUserPda(vaultPda);
  const [driftUserStatsPda] = getDriftUserStatsPda(vaultPda);

  return program.methods.openMarginPosition(
    marketIndex,
    direction,
    usdcCollateral,
    leverageBps,
    oraclePriceUsdc
  ).accounts({
    vault: vaultPda,
    usdcVault: usdcVaultPda,
    marginPosition: marginPosPda,
    driftUser: driftUserPda,
    driftUserStats: driftUserStatsPda,
    driftState: new PublicKey(DRIFT_CONFIG.state),
    driftSpotVault: new PublicKey(DRIFT_CONFIG.usdcSpotVault),
    usdcSpotMarket: new PublicKey(DRIFT_CONFIG.usdcSpotMarket),
    perpMarket: new PublicKey(market.perpMarket),
    usdcOracle: new PublicKey(DRIFT_CONFIG.usdcOracle),
    usdcMint: new PublicKey(USDC_MINT),
    perpOracle: new PublicKey(market.oracle),
    driftProgram: new PublicKey(DRIFT_CONFIG.programId),
    leader,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });
}

/** Place reverse reduce_only order to close the perp position */
export async function buildCloseMarginPositionTx(
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
  leader: PublicKey,
  marketIndex: number
) {
  const program = getProgram(provider);
  const market = getPerpMarket(marketIndex);
  const [marginPosPda] = getMarginPositionPda(vaultPda, marketIndex);
  const [driftUserPda] = getDriftUserPda(vaultPda);

  return program.methods.closeMarginPosition().accounts({
    vault: vaultPda,
    marginPosition: marginPosPda,
    driftUser: driftUserPda,
    driftState: new PublicKey(DRIFT_CONFIG.state),
    usdcSpotMarket: new PublicKey(DRIFT_CONFIG.usdcSpotMarket),
    perpMarket: new PublicKey(market.perpMarket),
    usdcOracle: new PublicKey(DRIFT_CONFIG.usdcOracle),
    perpOracle: new PublicKey(market.oracle),
    driftProgram: new PublicKey(DRIFT_CONFIG.programId),
    leader,
    systemProgram: SystemProgram.programId,
  });
}

/** Withdraw USDC from Drift after close order fills */
export async function buildWithdrawDriftUsdcTx(
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
  leader: PublicKey,
  marketIndex: number,
  withdrawAmount: anchor.BN  // µUSDC
) {
  const program = getProgram(provider);
  const market = getPerpMarket(marketIndex);
  const [usdcVaultPda] = getUsdcVaultPda(vaultPda);
  const [driftUserPda] = getDriftUserPda(vaultPda);
  const [driftUserStatsPda] = getDriftUserStatsPda(vaultPda);

  return program.methods.withdrawDriftUsdc(
    withdrawAmount,
    new anchor.BN(0) // min_usdc_out = 0 (no slippage protection)
  ).accounts({
    vault: vaultPda,
    usdcVault: usdcVaultPda,
    driftUser: driftUserPda,
    driftUserStats: driftUserStatsPda,
    driftState: new PublicKey(DRIFT_CONFIG.state),
    driftSpotVault: new PublicKey(DRIFT_CONFIG.usdcSpotVault),
    driftSigner: new PublicKey(DRIFT_CONFIG.signer),
    usdcSpotMarket: new PublicKey(DRIFT_CONFIG.usdcSpotMarket),
    usdcOracle: new PublicKey(DRIFT_CONFIG.usdcOracle),
    perpOracle: new PublicKey(market.oracle),
    perpMarket: new PublicKey(market.perpMarket),
    usdcMint: new PublicKey(USDC_MINT),
    driftProgram: new PublicKey(DRIFT_CONFIG.programId),
    leader,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });
}
