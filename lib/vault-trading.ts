import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { USDC_MINT } from '@/lib/contracts/config';
import { findVaultMintPda } from '@/lib/contracts/program';

export interface UserBalances {
  usdcBalance: string;       // human (6 dec)
  vaultTokenBalance: string; // human (9 dec)
  rawUsdc: bigint;
  rawVaultToken: bigint;
}

const USDC_DECIMALS = 6;
const VAULT_TOKEN_DECIMALS = 9;

function fmt(raw: bigint, decimals: number, fixed = 4): string {
  const denom = 10n ** BigInt(decimals);
  const whole = raw / denom;
  const frac = Number(raw % denom) / Number(denom);
  return (Number(whole) + frac).toFixed(fixed);
}

export async function loadUserBalances(
  connection: Connection,
  user: PublicKey,
  vaultState: PublicKey,
): Promise<UserBalances> {
  const [vaultMint] = findVaultMintPda(vaultState);
  const userUsdcAta  = await getAssociatedTokenAddress(USDC_MINT, user);
  const userVaultAta = await getAssociatedTokenAddress(vaultMint, user);

  const [usdcAcc, vaultAcc] = await Promise.all([
    getAccount(connection, userUsdcAta).catch(() => null),
    getAccount(connection, userVaultAta).catch(() => null),
  ]);

  const rawUsdc      = usdcAcc?.amount  ?? 0n;
  const rawVaultToken = vaultAcc?.amount ?? 0n;

  return {
    rawUsdc,
    rawVaultToken,
    usdcBalance:       fmt(rawUsdc, USDC_DECIMALS, 2),
    vaultTokenBalance: fmt(rawVaultToken, VAULT_TOKEN_DECIMALS, 4),
  };
}

/**
 * Count distinct holders of a vault token mint.
 * Uses getProgramAccounts on Token program with mint filter — can be expensive
 * on mainnet. On devnet with low holder counts it's fine.
 */
export async function countHolders(
  connection: Connection,
  vaultState: PublicKey,
): Promise<number> {
  const [vaultMint] = findVaultMintPda(vaultState);
  try {
    const accs = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: vaultMint.toBase58() } },
      ],
      dataSlice: { offset: 64, length: 8 }, // amount only
    });
    let nonZero = 0;
    for (const { account } of accs) {
      const amt = (account.data as Buffer).readBigUInt64LE(0);
      if (amt > 0n) nonZero++;
    }
    return nonZero;
  } catch {
    return 0;
  }
}

/**
 * Total supply of vault token (read from mint account).
 */
export async function readVaultMintSupply(
  connection: Connection,
  vaultState: PublicKey,
): Promise<{ supplyRaw: bigint; supply: string }> {
  const [vaultMint] = findVaultMintPda(vaultState);
  try {
    const info = await connection.getParsedAccountInfo(vaultMint);
    const parsed: any = (info.value?.data as any)?.parsed;
    const raw = BigInt(parsed?.info?.supply ?? '0');
    return { supplyRaw: raw, supply: fmt(raw, VAULT_TOKEN_DECIMALS, 2) };
  } catch {
    return { supplyRaw: 0n, supply: '0.00' };
  }
}

/**
 * Quick estimate of tokens received for a given USDC buy amount, ignoring
 * curve-state changes during the trade (good enough for a UI preview).
 *
 * Solana program follows the EVM AMM-style virtual reserves:
 *   tokensOut = virtualTokens - (virtualBase * virtualTokens) / (virtualBase + amountIn)
 */
export function estimateBuyTokens(
  usdcAmount: number,
  virtualBase: bigint,
  virtualTokens: bigint,
  tradingFeeBps = 100, // 1% default
): number {
  if (usdcAmount <= 0 || virtualTokens === 0n) return 0;
  const fee = (usdcAmount * tradingFeeBps) / 10_000;
  const net = usdcAmount - fee;
  // bring inputs into a common 9-dec internal scale (USDC has 6 dec)
  const netScaled = BigInt(Math.floor(net * 1_000_000_000)); // 9 dec
  const k = virtualBase * virtualTokens;
  const newBase = virtualBase + netScaled;
  const newTokens = k / newBase;
  const out = virtualTokens - newTokens;
  return Number(out) / 1e9;
}

export function estimateSellUsdc(
  tokenAmount: number,
  virtualBase: bigint,
  virtualTokens: bigint,
  tradingFeeBps = 100,
): number {
  if (tokenAmount <= 0 || virtualBase === 0n) return 0;
  const tokensIn = BigInt(Math.floor(tokenAmount * 1e9));
  const k = virtualBase * virtualTokens;
  const newTokens = virtualTokens + tokensIn;
  const newBase = k / newTokens;
  const out = virtualBase - newBase;
  const usdcGross = Number(out) / 1e9;
  return usdcGross * (1 - tradingFeeBps / 10_000);
}
