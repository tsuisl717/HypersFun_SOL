import { PublicKey } from '@solana/web3.js';

function readPubkey(envName: string, raw: string | undefined): PublicKey {
  if (!raw) {
    // During `next build` Next.js imports route modules to collect metadata.
    // If env is missing there, fall back to PublicKey.default so the build
    // doesn't blow up; any actual on-chain call will fail loudly at runtime
    // with the warning below.
    if (typeof window !== 'undefined') {
      console.error(
        `[config] ${envName} is not set. Solana calls will fail. ` +
        `Set this env var in your deployment dashboard.`,
      );
    }
    return PublicKey.default;
  }
  try {
    return new PublicKey(raw);
  } catch (e) {
    throw new Error(`[config] ${envName} is not a valid Solana pubkey: "${raw}"`);
  }
}

// Deployed HyperFun program (devnet)
export const PROGRAM_ID = readPubkey('NEXT_PUBLIC_PROGRAM_ID', process.env.NEXT_PUBLIC_PROGRAM_ID);

export const SOLANA_CONFIG = {
  network: process.env.NEXT_PUBLIC_SOLANA_NETWORK || 'devnet',
  rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.devnet.solana.com',
};

// USDC mint (Circle's official devnet USDC mint by default)
export const USDC_MINT = readPubkey('NEXT_PUBLIC_USDC_MINT', process.env.NEXT_PUBLIC_USDC_MINT);
