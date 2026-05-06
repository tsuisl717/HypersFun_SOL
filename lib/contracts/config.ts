import { PublicKey } from '@solana/web3.js';

// Deployed HyperFun program (devnet)
export const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID!);

export const SOLANA_CONFIG = {
  network: process.env.NEXT_PUBLIC_SOLANA_NETWORK || 'devnet',
  rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.devnet.solana.com',
};

// Devnet USDC (Circle's official devnet USDC mint)
export const USDC_MINT = new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT!);
