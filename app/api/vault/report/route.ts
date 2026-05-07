/**
 * GET /api/vault/report?vault=<pubkey>
 *
 * Returns a TRADING REPORT for a vault — mirrors the report mode of
 * HyperVapor-Fun's SimulationPanel, but fed by Solana on-chain data
 * instead of a TheGraph subgraph.
 *
 * Response shape:
 * {
 *   vault, lastSync,
 *   summary: {
 *     totalTrades, buyCount, sellCount,
 *     buyVolume, sellVolume, totalVolume, netFlow,
 *     uniqueTraders,
 *     vaultAgeDays,
 *     firstTradeTime, lastTradeTime,
 *     openPrice, lastPrice, priceChange24h, priceChangeAllTime,
 *     highPrice24h, lowPrice24h,
 *   },
 *   topHolders: [{ owner, balance, percent }],
 *   recentTrades: [...latest 50 trades],
 *   navHistory: [{ time, value }, ...] // sampled
 * }
 *
 * The shared trade cache (2-minute TTL) is reused; holder list is fetched
 * via getProgramAccounts on the SPL Token program filtered by the vault's
 * tokenMint.
 */

import { NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as anchor from '@coral-xyz/anchor';

import { ensureFreshTrades, getServerConnection } from '@/lib/vault-trade-cache';
import { getProgram } from '@/lib/contracts/margin';
import type { VaultTrade } from '@/lib/vault-events';

export const dynamic = 'force-dynamic';

// SPL Token account layout: 165 bytes total.
//   bytes  0..32  → mint (Pubkey)
//   bytes 32..64  → owner (Pubkey)
//   bytes 64..72  → amount (u64 LE)
const TOKEN_ACCOUNT_SIZE = 165;

interface HolderInfo {
  owner: string;
  balance: number;       // human (token decimals applied)
  percent: number;       // share of supply, 0–100
}

async function fetchHolders(
  tokenMint: PublicKey,
  decimals: number,
  limit = 100,
): Promise<{ holders: HolderInfo[]; totalSupply: number; uniqueHolders: number }> {
  const conn = getServerConnection();
  try {
    const accs = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [
        { dataSize: TOKEN_ACCOUNT_SIZE },
        { memcmp: { offset: 0, bytes: tokenMint.toBase58() } },
      ],
      // Slice owner (32 bytes) + amount (8 bytes), skip mint prefix.
      dataSlice: { offset: 32, length: 40 },
    });

    const denom = 10 ** decimals;
    const all: { owner: string; raw: bigint }[] = [];

    for (const { account } of accs) {
      const buf = account.data as Buffer;
      if (buf.length < 40) continue;
      const ownerBytes = buf.subarray(0, 32);
      const amountRaw = buf.readBigUInt64LE(32);
      if (amountRaw === 0n) continue;
      const owner = new PublicKey(ownerBytes).toBase58();
      all.push({ owner, raw: amountRaw });
    }

    const totalRaw = all.reduce((s, h) => s + h.raw, 0n);
    const totalSupply = Number(totalRaw) / denom;
    all.sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));

    const holders: HolderInfo[] = all.slice(0, limit).map((h) => {
      const balance = Number(h.raw) / denom;
      const percent = totalRaw > 0n ? Number((h.raw * 10000n) / totalRaw) / 100 : 0;
      return { owner: h.owner, balance, percent };
    });

    return { holders, totalSupply, uniqueHolders: all.length };
  } catch (e) {
    console.error('[api/vault/report] fetchHolders error', e);
    return { holders: [], totalSupply: 0, uniqueHolders: 0 };
  }
}

async function fetchVaultMintInfo(
  vaultPk: PublicKey,
): Promise<{ tokenMint: PublicKey; decimals: number; symbol: string; name: string; createdAtUnix?: number } | null> {
  try {
    const conn = getServerConnection();
    const provider = new anchor.AnchorProvider(
      conn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { publicKey: PublicKey.default } as any,
      { commitment: 'confirmed' },
    );
    const program = getProgram(provider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc: any = await (program.account as any).vault.fetch(vaultPk);
    const tokenMint = new PublicKey(acc.tokenMint);

    // Read mint decimals (mint account)
    const mintInfo = await conn.getParsedAccountInfo(tokenMint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 6;

    return {
      tokenMint,
      decimals,
      symbol: acc.symbol,
      name: acc.name,
      createdAtUnix: acc.createdAt?.toNumber?.(),
    };
  } catch (e) {
    console.error('[api/vault/report] fetchVaultMintInfo error', e);
    return null;
  }
}

function summarise(trades: VaultTrade[]) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      buyCount: 0,
      sellCount: 0,
      buyVolume: 0,
      sellVolume: 0,
      totalVolume: 0,
      netFlow: 0,
      uniqueTraders: 0,
      vaultAgeDays: 0,
      firstTradeTime: 0,
      lastTradeTime: 0,
      openPrice: 0,
      lastPrice: 0,
      priceChangeAllTime: 0,
      priceChange24h: 0,
      highPrice24h: 0,
      lowPrice24h: 0,
      avgTradeSize: 0,
    };
  }

  let buyCount = 0, sellCount = 0;
  let buyVolume = 0, sellVolume = 0;
  const traders = new Set<string>();

  for (const t of trades) {
    traders.add(t.user);
    if (t.side === 'buy')  { buyCount++;  buyVolume  += t.usdc; }
    if (t.side === 'sell') { sellCount++; sellVolume += t.usdc; }
  }

  const totalVolume = buyVolume + sellVolume;
  const netFlow = buyVolume - sellVolume;
  const firstTradeTime = trades[0].timestamp;
  const lastTradeTime = trades[trades.length - 1].timestamp;
  const vaultAgeDays = Math.max(0.001, (Date.now() / 1000 - firstTradeTime) / 86400);

  const openPrice = trades[0].price;
  const lastPrice = trades[trades.length - 1].price;
  const priceChangeAllTime = openPrice > 0 ? ((lastPrice - openPrice) / openPrice) * 100 : 0;

  // 24h slice
  const cutoff24h = Math.floor(Date.now() / 1000) - 86400;
  const last24h = trades.filter((t) => t.timestamp >= cutoff24h);
  const open24h = last24h.length > 0 ? last24h[0].price : lastPrice;
  const priceChange24h = open24h > 0 ? ((lastPrice - open24h) / open24h) * 100 : 0;
  const highPrice24h = last24h.length > 0 ? Math.max(...last24h.map((t) => t.price)) : lastPrice;
  const lowPrice24h  = last24h.length > 0 ? Math.min(...last24h.map((t) => t.price)) : lastPrice;

  return {
    totalTrades: trades.length,
    buyCount,
    sellCount,
    buyVolume,
    sellVolume,
    totalVolume,
    netFlow,
    uniqueTraders: traders.size,
    vaultAgeDays,
    firstTradeTime,
    lastTradeTime,
    openPrice,
    lastPrice,
    priceChangeAllTime,
    priceChange24h,
    highPrice24h,
    lowPrice24h,
    avgTradeSize: trades.length > 0 ? totalVolume / trades.length : 0,
  };
}

/** Down-sample trades to ~120 NAV points so the chart isn't huge */
function buildNavHistory(trades: VaultTrade[], maxPoints = 120) {
  if (trades.length === 0) return [];
  if (trades.length <= maxPoints) {
    return trades.map((t) => ({ time: t.timestamp, value: t.price }));
  }
  const step = Math.ceil(trades.length / maxPoints);
  const out: { time: number; value: number }[] = [];
  for (let i = 0; i < trades.length; i += step) {
    const t = trades[i];
    out.push({ time: t.timestamp, value: t.price });
  }
  // always include last
  const last = trades[trades.length - 1];
  if (out.length > 0 && out[out.length - 1].time !== last.timestamp) {
    out.push({ time: last.timestamp, value: last.price });
  }
  return out;
}

// ─── Handler ────────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const vault = url.searchParams.get('vault');
    if (!vault) {
      return NextResponse.json({ error: 'missing `vault` param' }, { status: 400 });
    }

    let vaultPk: PublicKey;
    try {
      vaultPk = new PublicKey(vault);
    } catch {
      return NextResponse.json({ error: 'invalid vault pubkey' }, { status: 400 });
    }

    // 1. Trade cache (shared with /candles)
    const entry = await ensureFreshTrades(vaultPk.toBase58());
    const summary = summarise(entry.trades);
    const navHistory = buildNavHistory(entry.trades, 120);
    const recentTrades = entry.trades.slice(-50).reverse(); // newest first

    // 2. Vault state (token mint + decimals)
    const vaultMeta = await fetchVaultMintInfo(vaultPk);
    let topHolders: HolderInfo[] = [];
    let uniqueHolders = 0;
    let tokenSupply = 0;
    if (vaultMeta) {
      const h = await fetchHolders(vaultMeta.tokenMint, vaultMeta.decimals, 50);
      topHolders = h.holders;
      uniqueHolders = h.uniqueHolders;
      tokenSupply = h.totalSupply;
    }

    return NextResponse.json(
      {
        vault: vaultPk.toBase58(),
        lastSync: entry.lastSync,
        meta: vaultMeta
          ? {
              symbol: vaultMeta.symbol,
              name: vaultMeta.name,
              tokenMint: vaultMeta.tokenMint.toBase58(),
              decimals: vaultMeta.decimals,
            }
          : null,
        summary: {
          ...summary,
          uniqueHolders,
          tokenSupply,
        },
        topHolders,
        recentTrades,
        navHistory,
      },
      {
        headers: {
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
        },
      },
    );
  } catch (e) {
    console.error('[api/vault/report] handler error:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal error' },
      { status: 500 },
    );
  }
}
