import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import { SOLANA_CONFIG } from '@/lib/contracts/config';
import {
  loadAllVaults as loadOnChainVaults,
  fetchVaultState,
  fetchVaultById,
  type VaultStateData,
} from '@/lib/contracts/program';

const connection = new Connection(SOLANA_CONFIG.rpcUrl, 'confirmed');

export interface VaultPosition {
  coin: string;
  size: number;
  isLong: boolean;
}

export interface VaultLinks {
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface VaultInfo {
  core: string;          // Solana program account pubkey
  trading: string;       // Solana trading wallet pubkey
  leader: string;        // Solana leader wallet pubkey
  name: string;
  symbol: string;
  performanceFeeBps: number;
  createdAt: number;
  verified: boolean;
  nav: string;
  totalSupply: string;
  buyPrice: string;
  metadataURI: string;
  imageUrl: string;
  description: string;
  links: VaultLinks;
  totalVolume: string;
  tvl: string;
  priceChange24h: number;
  priceChange: number;
  positions?: VaultPosition[];
  winRate?: number;
  apy?: number;
}

export type VaultUpdateCallback = (coreAddress: string, updates: Partial<VaultInfo>) => void;

const VAULTS_CACHE_KEY = 'vaults_cache';
const VAULTS_CACHE_TTL = 2 * 60 * 1000;

interface VaultsCache {
  data: VaultInfo[];
  timestamp: number;
}

export function getCachedVaults(): VaultInfo[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const cached = sessionStorage.getItem(VAULTS_CACHE_KEY);
    if (!cached) return null;
    const { data, timestamp }: VaultsCache = JSON.parse(cached);
    if (Date.now() - timestamp < VAULTS_CACHE_TTL) return data;
    return null;
  } catch {
    return null;
  }
}

function setCachedVaults(data: VaultInfo[]): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(VAULTS_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
  } catch {
    // ignore
  }
}

function updateCachedVault(coreAddress: string, updates: Partial<VaultInfo>): void {
  if (typeof window === 'undefined') return;
  try {
    const cached = sessionStorage.getItem(VAULTS_CACHE_KEY);
    if (!cached) return;
    const parsed: VaultsCache = JSON.parse(cached);
    const idx = parsed.data.findIndex(v => v.core === coreAddress);
    if (idx === -1) return;
    parsed.data[idx] = { ...parsed.data[idx], ...updates };
    sessionStorage.setItem(VAULTS_CACHE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

// ─── On-chain → UI converter ─────────────────────────────────────────────────

const PRECISION = 1_000_000_000n; // matches contract's 9-dec internal precision

/**
 * Convert raw VaultStateData into the UI-shaped VaultInfo (and fetch the
 * USDC ATA balance to compute TVL).
 */
async function toVaultInfo(v: VaultStateData): Promise<VaultInfo> {
  // ── Fetch USDC vault balance for TVL ──
  let tvlUsdc = 0;
  try {
    if (!v.usdcVault.equals(PublicKey.default)) {
      const acc = await getAccount(connection, v.usdcVault);
      tvlUsdc = Number(acc.amount) / 1_000_000; // USDC has 6 decimals
    }
  } catch { /* ATA might not exist yet — pre-init_vault_assets */ }

  // ── NAV (smoothed): twap_nav is in 9-dec internal units ──
  const navInternal = v.twapNav > 0n ? v.twapNav : PRECISION;
  const navStr = (Number(navInternal) / Number(PRECISION)).toFixed(4);

  return {
    core:               v.pubkey.toBase58(),
    trading:            v.tradingState.toBase58(),
    leader:             v.leader.toBase58(),
    name:               v.name,
    symbol:             v.symbol,
    performanceFeeBps:  Number(v.feeBps),
    createdAt:          v.createdAt,
    verified:           v.verified,
    nav:                navStr,
    totalSupply:        '0',                 // TODO: read vault_mint.supply
    buyPrice:           navStr,
    metadataURI:        v.metadataUri,
    imageUrl:           '',
    description:        '',
    links:              {},
    totalVolume:        (Number(v.totalVolume) / Number(PRECISION)).toFixed(2),
    tvl:                tvlUsdc.toFixed(2),
    priceChange24h:     0,                   // TODO: derive from TWAP history
    priceChange:        0,
    positions:          [],
    winRate:            0,
    apy:                0,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function loadVaults(
  onUpdate?: VaultUpdateCallback,
  forceRefresh?: boolean,
): Promise<VaultInfo[]> {
  if (!forceRefresh) {
    const cached = getCachedVaults();
    if (cached) {
      console.log('[loadVaults] cache hit:', cached);
      return cached;
    }
  }
  console.log('[loadVaults] fetching from', SOLANA_CONFIG.rpcUrl);
  const onChain = await loadOnChainVaults(connection);
  console.log(`[loadVaults] on-chain VaultStateData (${onChain.length}):`,
    onChain.map(v => ({
      pubkey:        v.pubkey.toBase58(),
      vaultId:       v.vaultId.toString(),
      name:          v.name,
      symbol:        v.symbol,
      leader:        v.leader.toBase58(),
      tradingState:  v.tradingState.toBase58(),
      vaultMint:     v.vaultMint.toBase58(),
      usdcVault:     v.usdcVault.toBase58(),
      feeBps:        v.feeBps.toString(),
      virtualBase:   v.virtualBase.toString(),
      virtualTokens: v.virtualTokens.toString(),
      totalDeposits: v.totalDeposits.toString(),
      totalVolume:   v.totalVolume.toString(),
      twapNav:       v.twapNav.toString(),
      twapNavTime:   v.twapNavTime,
      paused:        v.paused,
      verified:      v.verified,
      createdAt:     v.createdAt,
      metadataUri:   v.metadataUri,
    })),
  );

  const vaults = await Promise.all(onChain.map(toVaultInfo));
  console.log(`[loadVaults] converted VaultInfo (${vaults.length}):`, vaults);
  setCachedVaults(vaults);

  // Stream metadata fetches in the background — caller's onUpdate gets
  // called per-vault as each IPFS / data: / http resolve completes; cache
  // is updated per-vault so partial progress survives reloads.
  void hydrateMetadata(vaults, onUpdate);

  return vaults;
}

async function hydrateMetadata(
  vaults: VaultInfo[],
  onUpdate?: VaultUpdateCallback,
): Promise<void> {
  const targets = vaults.filter(v => v.metadataURI && !v.imageUrl && !v.description);
  console.log(`[hydrateMetadata] ${targets.length}/${vaults.length} vaults have metadataURI`);
  if (targets.length === 0) return;

  await Promise.allSettled(targets.map(async (v) => {
    console.log(`[hydrateMetadata] fetching ${v.core} → ${v.metadataURI}`);
    const meta = await parseMetadata(v.metadataURI);
    console.log(`[hydrateMetadata] ${v.core} parsed:`, meta);
    const updates: Partial<VaultInfo> = {
      imageUrl:    meta.imageUrl    || '',
      description: meta.description || '',
      links:       meta.links       || {},
    };
    Object.assign(v, updates);
    updateCachedVault(v.core, updates);
    onUpdate?.(v.core, updates);
  }));
}

export async function loadVaultByAddress(coreAddress: string): Promise<VaultInfo | null> {
  let pubkey: PublicKey;
  try { pubkey = new PublicKey(coreAddress); } catch { return null; }

  const v = await fetchVaultState(connection, pubkey);
  if (!v) return null;
  const info = await toVaultInfo(v);
  if (info.metadataURI) {
    const meta = await parseMetadata(info.metadataURI);
    info.imageUrl    = meta.imageUrl    || '';
    info.description = meta.description || '';
    info.links       = meta.links       || {};
  }
  return info;
}

export async function loadVaultById(vaultId: number | bigint): Promise<VaultInfo | null> {
  const v = await fetchVaultById(connection, vaultId);
  if (!v) return null;
  const info = await toVaultInfo(v);
  if (info.metadataURI) {
    const meta = await parseMetadata(info.metadataURI);
    info.imageUrl    = meta.imageUrl    || '';
    info.description = meta.description || '';
    info.links       = meta.links       || {};
  }
  return info;
}

// ─── Metadata helpers ────────────────────────────────────────────────────────

const PINATA_GW = 'https://cyan-defeated-lemming-99.mypinata.cloud/ipfs/';
const DATA_JSON_PREFIX = 'data:application/json;base64,';

async function fetchMetadataJson(metadataURI: string): Promise<any | null> {
  if (!metadataURI) {
    console.warn('[fetchMetadataJson] empty URI');
    return null;
  }
  console.log('[fetchMetadataJson] fetching:', metadataURI);
  try {
    if (metadataURI.startsWith(DATA_JSON_PREFIX)) {
      const b64 = metadataURI.slice(DATA_JSON_PREFIX.length);
      const decoded = typeof atob === 'function'
        ? atob(b64)
        : Buffer.from(b64, 'base64').toString('utf-8');
      console.log('[fetchMetadataJson] data: prefix decoded:', decoded);
      const json = JSON.parse(decoded);
      console.log('[fetchMetadataJson] parsed JSON:', json);
      return json;
    }
    if (metadataURI.startsWith('ipfs://')) {
      const hash = metadataURI.replace('ipfs://', '');
      const url = PINATA_GW + hash;
      console.log('[fetchMetadataJson] ipfs → http:', url);
      const res = await fetch(url, { cache: 'no-store' });
      console.log('[fetchMetadataJson] response status:', res.status, res.ok);
      if (!res.ok) {
        console.error('[fetchMetadataJson] HTTP error', res.status, await res.text());
        return null;
      }
      const json = await res.json();
      console.log('[fetchMetadataJson] parsed JSON:', json);
      return json;
    }
    if (metadataURI.startsWith('http://') || metadataURI.startsWith('https://')) {
      console.log('[fetchMetadataJson] http fetch:', metadataURI);
      const res = await fetch(metadataURI, { cache: 'no-store' });
      console.log('[fetchMetadataJson] response status:', res.status, res.ok);
      if (!res.ok) {
        console.error('[fetchMetadataJson] HTTP error', res.status, await res.text());
        return null;
      }
      const json = await res.json();
      console.log('[fetchMetadataJson] parsed JSON:', json);
      return json;
    }
    console.warn('[fetchMetadataJson] unknown URI scheme:', metadataURI);
    return null;
  } catch (err) {
    console.error('[fetchMetadataJson] threw:', err, '  for URI:', metadataURI);
    return null;
  }
}

function resolveImageUrl(image: unknown): string {
  console.log('[resolveImageUrl] raw image field:', image, '(type:', typeof image, ')');
  if (typeof image !== 'string' || !image) {
    console.warn('[resolveImageUrl] not a string or empty');
    return '';
  }
  if (image.startsWith('ipfs://')) {
    const url = PINATA_GW + image.replace('ipfs://', '');
    console.log('[resolveImageUrl] ipfs → http:', url);
    return url;
  }
  if (image.startsWith('data:')) {
    console.log('[resolveImageUrl] data: URI (length:', image.length, ')');
    return image;
  }
  if (image.startsWith('http://') || image.startsWith('https://')) {
    console.log('[resolveImageUrl] direct http URL:', image);
    return image;
  }
  console.warn('[resolveImageUrl] unknown scheme, returning empty:', image);
  return '';
}

export async function parseMetadataImage(metadataURI: string): Promise<string> {
  const json = await fetchMetadataJson(metadataURI);
  return resolveImageUrl(json?.image);
}

export async function parseMetadata(metadataURI: string): Promise<{
  imageUrl: string;
  description: string;
  links: { website?: string; twitter?: string; telegram?: string };
}> {
  console.group('[parseMetadata]', metadataURI);
  const json = await fetchMetadataJson(metadataURI);
  if (!json) {
    console.warn('[parseMetadata] no JSON, returning empty');
    console.groupEnd();
    return { imageUrl: '', description: '', links: {} };
  }
  console.log('[parseMetadata] JSON keys:', Object.keys(json));
  console.log('[parseMetadata] json.image:', json.image);
  console.log('[parseMetadata] json.imageUrl:', json.imageUrl);
  console.log('[parseMetadata] json.description:', json.description);
  console.log('[parseMetadata] json.links:', json.links);

  // Try multiple common keys for image (image / imageUrl / image_url)
  const imageRaw = json.image ?? json.imageUrl ?? json.image_url;
  const result = {
    imageUrl:    resolveImageUrl(imageRaw),
    description: typeof json.description === 'string' ? json.description : '',
    links: {
      website:  typeof json.links?.website  === 'string' ? json.links.website  : undefined,
      twitter:  typeof json.links?.twitter  === 'string' ? json.links.twitter  : undefined,
      telegram: typeof json.links?.telegram === 'string' ? json.links.telegram : undefined,
    },
  };
  console.log('[parseMetadata] FINAL:', result);
  console.groupEnd();
  return result;
}
