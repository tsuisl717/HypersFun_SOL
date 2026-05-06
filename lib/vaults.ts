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
  _onUpdate?: VaultUpdateCallback,
  forceRefresh?: boolean,
): Promise<VaultInfo[]> {
  if (!forceRefresh) {
    const cached = getCachedVaults();
    if (cached) return cached;
  }
  const onChain = await loadOnChainVaults(connection);
  const vaults  = await Promise.all(onChain.map(toVaultInfo));
  setCachedVaults(vaults);
  return vaults;
}

export async function loadVaultByAddress(coreAddress: string): Promise<VaultInfo | null> {
  let pubkey: PublicKey;
  try { pubkey = new PublicKey(coreAddress); } catch { return null; }

  const v = await fetchVaultState(connection, pubkey);
  return v ? toVaultInfo(v) : null;
}

export async function loadVaultById(vaultId: number | bigint): Promise<VaultInfo | null> {
  const v = await fetchVaultById(connection, vaultId);
  return v ? toVaultInfo(v) : null;
}

export async function parseMetadataImage(metadataURI: string): Promise<string> {
  if (!metadataURI) return '';
  try {
    if (metadataURI.startsWith('ipfs://')) {
      const hash = metadataURI.replace('ipfs://', '');
      const res = await fetch(`https://cyan-defeated-lemming-99.mypinata.cloud/ipfs/${hash}`, { cache: 'no-store' });
      const json = await res.json();
      if (json?.image?.startsWith('ipfs://')) {
        return `https://cyan-defeated-lemming-99.mypinata.cloud/ipfs/${json.image.replace('ipfs://', '')}`;
      }
      return json?.image || '';
    }
    return '';
  } catch {
    return '';
  }
}

export async function parseMetadata(metadataURI: string): Promise<{ imageUrl: string; description: string; links: { website?: string; twitter?: string; telegram?: string } }> {
  return { imageUrl: '', description: '', links: {} };
}
