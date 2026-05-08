/**
 * GET /api/vault/candles?vault=<pubkey>&interval=<1m|5m|15m|1h|4h|1d>&limit=<N>
 *
 * Returns OHLCV candles aggregated from on-chain BuyEvent / SellEvent.
 * Uses the shared trade cache (lib/vault-trade-cache.ts) — 2-minute TTL,
 * incremental sync, single-flight per vault.
 */

import { NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';

import {
  buildCandlesFromTrades,
  intervalToSeconds,
  SUPPORTED_INTERVALS,
  type Interval,
} from '@/lib/vault-events';
import { ensureFreshTrades } from '@/lib/vault-trade-cache';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const vault = url.searchParams.get('vault');
    const intervalParam = (url.searchParams.get('interval') ?? '15m') as Interval;
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') ?? '300', 10), 1),
      1000,
    );

    if (!vault) {
      return NextResponse.json({ error: 'missing `vault` param' }, { status: 400 });
    }

    let vaultPk: PublicKey;
    try {
      vaultPk = new PublicKey(vault);
    } catch {
      return NextResponse.json({ error: 'invalid vault pubkey' }, { status: 400 });
    }

    if (!SUPPORTED_INTERVALS.includes(intervalParam)) {
      return NextResponse.json(
        { error: `invalid interval; must be one of ${SUPPORTED_INTERVALS.join(', ')}` },
        { status: 400 },
      );
    }

    const force = url.searchParams.get('force') === '1';
    const entry = await ensureFreshTrades(vaultPk.toBase58(), { force });
    const intervalSecs = intervalToSeconds(intervalParam);
    const allCandles = buildCandlesFromTrades(entry.trades, intervalSecs);
    const candles = allCandles.slice(-limit);

    return NextResponse.json(
      {
        vault: vaultPk.toBase58(),
        interval: intervalParam,
        tradeCount: entry.trades.length,
        candles,
        lastSync: entry.lastSync,
      },
      {
        headers: {
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=120',
        },
      },
    );
  } catch (e) {
    console.error('[api/vault/candles] handler error:', e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'internal error' },
      { status: 500 },
    );
  }
}
