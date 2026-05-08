import { Connection, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { CONFIG, PROGRAM_ID, PRECISION } from './contracts/config';
import { getProgram } from './contracts/margin';
import type { TokenPosition } from '@/types';

// Drift perp market index → base symbol (subset of KNOWN_MARKETS in lib/drift/api.ts)
const MARKET_BASE: Record<number, string> = {
  0: 'SOL', 1: 'BTC', 2: 'ETH', 3: 'APT', 4: 'BONK', 5: 'MATIC', 6: 'ARB',
  7: 'DOGE', 8: 'BNB', 9: 'SUI', 10: 'PEPE', 11: 'OP', 12: 'RNDR', 13: 'XRP',
  14: 'HNT', 15: 'INJ', 16: 'LINK', 17: 'RLB', 18: 'PYTH', 19: 'TIA',
  20: 'JTO', 21: 'SEI', 22: 'AVAX', 23: 'WIF', 24: 'JUP', 25: 'DYM',
  26: 'TAO', 27: 'W', 28: 'KMNO', 29: 'TNSR',
};

export interface VaultLinks {
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface VaultInfo {
  address: string;
  leader: string;
  name: string;
  symbol: string;
  metadataUri: string;
  tokenMint: string;
  usdcReserve: number;
  totalSupply: number;
  totalVolume: number;
  externalAssets: number;
  performanceFeeBps: number;
  nav: string;
  buyPrice: string;
  sellPrice: string;
  tvl: string;
  isPaused: boolean;
  createdAt: number; // unix seconds — using twap_last_updated as proxy (no createdAt on chain)
  positions: TokenPosition[]; // open Drift perp positions for this vault
  // Hydrated from metadataUri JSON (populated by hydrateMetadata)
  imageUrl?: string;
  description?: string;
  links?: VaultLinks;
}

export type VaultUpdateCallback = (address: string, updates: Partial<VaultInfo>) => void;

function getConnection(): Connection {
  return new Connection(CONFIG.rpcUrl, 'confirmed');
}

// Anchor discriminator for "account:Vault"
const VAULT_DISCRIMINATOR = Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]);

export function calcBuyPrice(
  virtualBase: number,
  virtualTokens: number,
  usdcIn: number
): { tokensOut: number; price: number } {
  const tokensOut = (virtualTokens * usdcIn) / (virtualBase + usdcIn);
  const price = tokensOut > 0 ? usdcIn / tokensOut : 0;
  return { tokensOut, price };
}

export function calcSellPrice(
  virtualBase: number,
  virtualTokens: number,
  tokensIn: number
): number {
  return (virtualBase * tokensIn) / (virtualTokens + tokensIn);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseVault(address: string, raw: any): VaultInfo {
  const usdcReserve    = raw.usdcReserve.toNumber()    / 1_000_000;
  const externalAssets = raw.externalAssets.toNumber() / 1_000_000;
  const totalSupply    = raw.totalSupply.toNumber()    / 1_000_000;
  const tvlNum         = usdcReserve + externalAssets;

  const navNum = totalSupply > 0 ? tvlNum / totalSupply : 1;

  const vBase = PRECISION * navNum;
  const vTok  = PRECISION;
  const { price: buyPrice } = calcBuyPrice(vBase, vTok, 1);
  const sellPrice = calcSellPrice(vBase, vTok, 1);

  return {
    address,
    leader:          raw.leader.toBase58(),
    name:            raw.name,
    symbol:          raw.symbol,
    metadataUri:     raw.metadataUri ?? '',
    tokenMint:       raw.tokenMint.toBase58(),
    usdcReserve,
    totalSupply,
    totalVolume:     0,
    externalAssets,
    performanceFeeBps: raw.performanceFeeBps ?? 0,
    nav:             navNum.toFixed(4),
    buyPrice:        (1 / buyPrice).toFixed(6),
    sellPrice:       sellPrice.toFixed(6),
    tvl:             tvlNum.toFixed(2),
    isPaused:        raw.isPaused ?? false,
    createdAt:       Number(raw.twapLastUpdated?.toString?.() ?? 0),
    positions:       [],
  };
}

/**
 * Fetches every open MarginPosition account in one RPC call and groups them
 * by their parent vault address. Used by loadVaults so the home-page TokenCard
 * can show each vault's live Drift perp positions without N+1 fetches.
 */
async function loadOpenPositionsByVault(
  program: anchor.Program,
): Promise<Map<string, TokenPosition[]>> {
  const out = new Map<string, TokenPosition[]>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: any[] = await (program.account as any).marginPosition.all();
    for (const a of accs) {
      const acc = a.account;
      if (!acc?.isOpen) continue;
      const vaultAddr = acc.vault.toBase58();
      const baseAmount = Number(acc.baseAssetAmount?.toString?.() ?? 0) / 1e9;
      const coin = MARKET_BASE[acc.marketIndex] ?? `MKT-${acc.marketIndex}`;
      const pos: TokenPosition = {
        coin,
        size: baseAmount,
        isLong: acc.direction !== 1, // 0=long, 1=short
      };
      const list = out.get(vaultAddr) ?? [];
      list.push(pos);
      out.set(vaultAddr, list);
    }
  } catch (e) {
    console.error('[loadOpenPositionsByVault] failed:', e);
  }
  return out;
}

export async function loadVaults(
  onUpdate?: VaultUpdateCallback,
): Promise<VaultInfo[]> {
  try {
    const connection = getConnection();
    const provider = new anchor.AnchorProvider(
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { publicKey: PublicKey.default } as any,
      { commitment: 'confirmed' }
    );
    const program = getProgram(provider);

    const [accounts, positionsByVault] = await Promise.all([
      connection.getProgramAccounts(new PublicKey(PROGRAM_ID), {
        filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(VAULT_DISCRIMINATOR) } }],
      }),
      loadOpenPositionsByVault(program),
    ]);

    const vaults: VaultInfo[] = [];
    for (const { pubkey } of accounts) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await (program.account as any).vault.fetch(pubkey);
        const v = parseVault(pubkey.toBase58(), raw);
        v.positions = positionsByVault.get(v.address) ?? [];
        vaults.push(v);
      } catch {
        // skip accounts that fail to deserialize
      }
    }

    // Hydrate metadata in background — caller's onUpdate is called per-vault as
    // each IPFS / data: / http URI resolves.
    void hydrateMetadata(vaults, onUpdate);

    return vaults;
  } catch (e) {
    console.error('loadVaults error:', e);
    return [];
  }
}

export async function loadVaultByAddress(address: string): Promise<VaultInfo | null> {
  try {
    const connection = getConnection();
    const provider = new anchor.AnchorProvider(
      connection,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { publicKey: PublicKey.default } as any,
      { commitment: 'confirmed' }
    );
    const program = getProgram(provider);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (program.account as any).vault.fetch(new PublicKey(address));
    const info = parseVault(address, raw);
    if (info.metadataUri) {
      const meta = await parseMetadata(info.metadataUri);
      info.imageUrl    = meta.imageUrl;
      info.description = meta.description;
      info.links       = meta.links;
    }
    return info;
  } catch {
    return null;
  }
}

// ─── Metadata helpers ────────────────────────────────────────────────────────

const PINATA_GW = 'https://cyan-defeated-lemming-99.mypinata.cloud/ipfs/';
const DATA_JSON_PREFIX = 'data:application/json;base64,';

async function hydrateMetadata(
  vaults: VaultInfo[],
  onUpdate?: VaultUpdateCallback,
): Promise<void> {
  const targets = vaults.filter(v => v.metadataUri && !v.imageUrl);
  if (targets.length === 0) return;

  await Promise.allSettled(targets.map(async (v) => {
    const meta = await parseMetadata(v.metadataUri);
    const updates: Partial<VaultInfo> = {
      imageUrl:    meta.imageUrl,
      description: meta.description,
      links:       meta.links,
    };
    Object.assign(v, updates);
    onUpdate?.(v.address, updates);
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchMetadataJson(metadataURI: string): Promise<any | null> {
  if (!metadataURI) return null;
  try {
    if (metadataURI.startsWith(DATA_JSON_PREFIX)) {
      const b64 = metadataURI.slice(DATA_JSON_PREFIX.length);
      const decoded = typeof atob === 'function'
        ? atob(b64)
        : Buffer.from(b64, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    }
    if (metadataURI.startsWith('ipfs://')) {
      const hash = metadataURI.replace('ipfs://', '');
      const res = await fetch(PINATA_GW + hash, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    }
    if (metadataURI.startsWith('http://') || metadataURI.startsWith('https://')) {
      const res = await fetch(metadataURI, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    }
    return null;
  } catch (err) {
    console.error('[fetchMetadataJson] failed:', err, metadataURI);
    return null;
  }
}

function resolveImageUrl(image: unknown): string {
  if (typeof image !== 'string' || !image) return '';
  if (image.startsWith('ipfs://')) return PINATA_GW + image.replace('ipfs://', '');
  if (image.startsWith('data:'))   return image;
  if (image.startsWith('http://') || image.startsWith('https://')) return image;
  return '';
}

export async function parseMetadata(metadataURI: string): Promise<{
  imageUrl: string;
  description: string;
  links: VaultLinks;
}> {
  const json = await fetchMetadataJson(metadataURI);
  if (!json) return { imageUrl: '', description: '', links: {} };

  const imageRaw = json.image ?? json.imageUrl ?? json.image_url;
  return {
    imageUrl:    resolveImageUrl(imageRaw),
    description: typeof json.description === 'string' ? json.description : '',
    links: {
      website:  typeof json.links?.website  === 'string' ? json.links.website  : undefined,
      twitter:  typeof json.links?.twitter  === 'string' ? json.links.twitter  : undefined,
      telegram: typeof json.links?.telegram === 'string' ? json.links.telegram : undefined,
    },
  };
}
