// Solana HypersFun Contract Configuration

export type NetworkType = 'devnet' | 'mainnet-beta';

export const NETWORK: NetworkType =
  (process.env.NEXT_PUBLIC_SOLANA_NETWORK as NetworkType) || 'devnet';

const NETWORK_CONFIG = {
  devnet: {
    programId: '5jmoeSiY3kyFhaipuiV1Six4sAwMetsEWNNCTBdfrEza',
    factoryPda: 'BifoNKMbqCWLuHpFyXABGiRC6W7Hty5RtakkUrK5USLN',
    // Drift devnet USDC (vELoC1 deployment)
    usdcMint: '8FfvSRKMZRDHrCBy142XMUXrKEkXnxDQ4YmJv7xbAw8Q',
    rpcUrl: 'https://api.devnet.solana.com',
    explorerUrl: 'https://explorer.solana.com/?cluster=devnet',
    wsUrl: 'wss://api.devnet.solana.com',
    // Drift Protocol devnet (vELoC1 deployment)
    drift: {
      programId: 'vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P',
      state: 'HAjeZdvbUYWWsWJqEdxYVdwGc4D8XojUYW7hTsiU6crJ',
      usdcSpotMarket: '2QpHj5vzgCdWaGM2KSoGtYJWeSkx24cMyzUDHDrucvRc',
      usdcSpotVault: 'G9NKtiafHiCTArgVouXx6XS7Jb3DqigrT6S6BgSDLrvz',
      solPerpMarket: 'FDejXbUrSy6zayBCL5xuk2SXLHZgr8ppfFTLcHbyJorY',
      signer: '4LFc5tcKjdqARYsFNwwt3mjCHEnE83HQkoosb92kWUc9',
      usdcOracle: 'Dai8hT1YRBBm5rBSJUSKcdR11psM55LVAkshbypfC4k4',
      solOracle: '2k3UHX6ehRFzx5fTVvbL6FwXhMjkucjJDL9MuVKLo8TV',
    },
  },
  'mainnet-beta': {
    programId: process.env.NEXT_PUBLIC_PROGRAM_ID || '',
    factoryPda: process.env.NEXT_PUBLIC_FACTORY_PDA || '',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com',
    explorerUrl: 'https://explorer.solana.com',
    wsUrl: process.env.NEXT_PUBLIC_WS_URL || 'wss://api.mainnet-beta.solana.com',
    drift: {
      programId: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
      state: 'EuyXV6fFfRPT8MAXhZ6akStBfFtQpZAFyJHgPnEFYWqA',
      usdcSpotMarket: '6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3',
      usdcSpotVault: 'GXWqPpjQpdz7KZw9p7f5PX2eGxHAhvpNXiviFkAB8zXg',
      solPerpMarket: '8UJgxaiQx5nTrdDgSigns5A1Ti8NLtD5UyADgaGL8Yx9',
      signer: 'H9pKoZ6X2b6UrC37rRJAVCQXcHpJuuTPcS4MxjWAEL4J',
      usdcOracle: 'En8hkHLkRe9d9DraYmBTrus518BvmVy448jAgLFQQ5DR',
      solOracle: 'BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF',
    },
  },
};

export const CONFIG = NETWORK_CONFIG[NETWORK];

export const PROGRAM_ID = CONFIG.programId;
export const FACTORY_PDA = CONFIG.factoryPda;
export const USDC_MINT = CONFIG.usdcMint;
export const DRIFT_CONFIG = CONFIG.drift;

// Constants (matches Rust program)
export const BPS = 10_000;
export const PRECISION = 1_000_000;
export const USDC_DECIMALS = 6;
export const TOKEN_DECIMALS = 6;

export const MAX_PERFORMANCE_FEE_BPS = 3000; // 30% max

export const EXIT_FEE_TIERS = [
  { days: 0,  bps: 1500, label: '< 3 days' },
  { days: 3,  bps: 800,  label: '3-7 days' },
  { days: 7,  bps: 300,  label: '7-30 days' },
  { days: 30, bps: 0,    label: '> 30 days' },
];

export function formatUsdc(amount: number | bigint, decimals = 2): string {
  const n = typeof amount === 'bigint' ? Number(amount) : amount;
  return (n / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function parseUsdc(amount: string | number): bigint {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  return BigInt(Math.floor(n * 1_000_000));
}

export function getExplorerUrl(type: 'tx' | 'account' | 'token', id: string): string {
  const base = CONFIG.explorerUrl;
  if (type === 'tx') return `${base}/tx/${id}`;
  if (type === 'token') return `${base}/address/${id}`;
  return `${base}/address/${id}`;
}
