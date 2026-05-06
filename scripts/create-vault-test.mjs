/**
 * Standalone create-vault test script.
 *
 * Run from PowerShell:
 *   cd "C:\Users\user\Desktop\Git\HypersFun_SOL"
 *   node scripts/create-vault-test.mjs
 *
 * Uses id.json (the deployer wallet) to call create_vault on devnet.
 * Pre-creates USDC ATAs if they don't exist.
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  getAccount, TokenAccountNotFoundError, TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import fs from 'node:fs';

// ─── Config ──────────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey('Fw34m2EoYUqFuTHRZSzdtWRNiEHg3RJpDyjnDfM2gDpe');
const USDC_MINT  = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const RPC        = 'https://api.devnet.solana.com';
const ID_JSON    = 'C:\\Users\\user\\Desktop\\Project\\HypersFun_Contract_Test\\id.json';

const VAULT_NAME              = 'Alpha Test Vault';
const VAULT_SYMBOL            = 'ALPHA';
const PERFORMANCE_FEE_PERCENT = 20;            // 20 %

// ─── Encoders ────────────────────────────────────────────────────────────────
const disc = (name) => Buffer.from(sha256(`global:${name}`).slice(0, 8));

const enc_string = (s) => {
  const bytes = Buffer.from(s, 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
};

const enc_u64 = (n) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n), 0);
  return buf;
};

const enc_u128 = (n) => {
  const v = BigInt(n);
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(v & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE(v >> 64n, 8);
  return buf;
};

// ─── PDAs ────────────────────────────────────────────────────────────────────
const findFactoryPda   = ()      => PublicKey.findProgramAddressSync([Buffer.from('factory')], PROGRAM_ID);
const findVaultPda     = (id)    => PublicKey.findProgramAddressSync([Buffer.from('vault'), enc_u64(id)], PROGRAM_ID);
const findTradingPda   = (vault) => PublicKey.findProgramAddressSync([Buffer.from('trading'), vault.toBuffer()], PROGRAM_ID);
const findVaultMintPda = (vault) => PublicKey.findProgramAddressSync([Buffer.from('vault-mint'), vault.toBuffer()], PROGRAM_ID);

// ─── FactoryState read ───────────────────────────────────────────────────────
function parseFactory(data) {
  // skip 8-byte discriminator
  const d = data.subarray(8);
  const authority   = new PublicKey(d.subarray(0, 32));
  const treasury    = new PublicKey(d.subarray(32, 64));
  const usdcMint    = new PublicKey(d.subarray(64, 96));
  const creationFee = d.readBigUInt64LE(96);

  // Walk to paused + vault_count fields
  let off = 96 + 8 + 48 + 32 + 8 + 72 + 32 + 1 + 8 + 1 + 8 + 16 + 8 + 16 + 8 + 1 + 560 + 1 + 160 + 1;
  const paused     = d.readUInt8(off) !== 0; off += 1;
  const vaultCount = d.readBigUInt64LE(off);

  return { authority, treasury, usdcMint, creationFee, paused, vaultCount };
}

// ─── Ensure ATA exists ───────────────────────────────────────────────────────
async function ensureAtaIx(connection, payer, mint, owner) {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  try {
    await getAccount(connection, ata);
    return { ata, ix: null };
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError || e instanceof TokenInvalidAccountOwnerError) {
      return {
        ata,
        ix: createAssociatedTokenAccountInstruction(payer, ata, owner, mint),
      };
    }
    throw e;
  }
}

// ─── Build create_vault instruction ──────────────────────────────────────────
// New (after refactor): only leader + factory + vault_state + trading_state +
// token_program + system_program. mint + usdc_vault moved to init_vault_assets.
function buildCreateVaultIx(accs, args) {
  const data = Buffer.concat([
    disc('create_vault'),
    enc_string(args.name),
    enc_string(args.symbol),
    enc_u64(args.performanceFeeBps),
    enc_u128(args.bcVirtualBase ?? 0),
    enc_u128(args.bcVirtualTokens ?? 0),
    enc_u128(args.initialAssets ?? 0),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accs.leader,         isSigner: true,  isWritable: true  },
      { pubkey: accs.factoryState,   isSigner: false, isWritable: true  },
      { pubkey: accs.vaultState,     isSigner: false, isWritable: true  },
      { pubkey: accs.tradingState,   isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Build init_vault_assets instruction (creates mint + usdc ATA) ───────────
function buildInitVaultAssetsIx(accs) {
  const data = disc('init_vault_assets');
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accs.leader,        isSigner: true,  isWritable: true  },
      { pubkey: accs.vaultState,    isSigner: false, isWritable: true  },
      { pubkey: accs.vaultMint,     isSigner: false, isWritable: true  },
      { pubkey: accs.usdcVault,     isSigner: false, isWritable: true  },
      { pubkey: accs.usdcMint,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,            isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,          isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔍 Loading keypair...');
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(ID_JSON, 'utf-8'))),
  );
  console.log('   wallet:', keypair.publicKey.toBase58());

  const connection = new Connection(RPC, 'confirmed');
  const bal = await connection.getBalance(keypair.publicKey);
  console.log('   balance:', bal / LAMPORTS_PER_SOL, 'SOL\n');

  // ── 1. Read factory ──────────────────────────────────────────────────────
  const [factoryPda] = findFactoryPda();
  console.log('🏭 Factory PDA:', factoryPda.toBase58());

  const factoryAcc = await connection.getAccountInfo(factoryPda);
  if (!factoryAcc) {
    console.error('❌ Factory not initialized. Run initialize_factory first.');
    process.exit(1);
  }

  const factory = parseFactory(factoryAcc.data);
  console.log('   authority   :', factory.authority.toBase58());
  console.log('   treasury    :', factory.treasury.toBase58());
  console.log('   usdc_mint   :', factory.usdcMint.toBase58());
  console.log('   creation_fee:', factory.creationFee.toString(), '(USDC 6-dec)');
  console.log('   vault_count :', factory.vaultCount.toString());
  console.log('   paused      :', factory.paused);
  console.log('');

  if (factory.paused) {
    console.error('❌ Factory is paused.');
    process.exit(1);
  }

  // ── 2. Derive new vault PDAs ─────────────────────────────────────────────
  const vaultId = factory.vaultCount;
  const [vaultPda]     = findVaultPda(vaultId);
  const [tradingPda]   = findTradingPda(vaultPda);
  const [vaultMintPda] = findVaultMintPda(vaultPda);

  console.log('🆕 New vault (id =', vaultId.toString() + '):');
  console.log('   vault_state :', vaultPda.toBase58());
  console.log('   trading     :', tradingPda.toBase58());
  console.log('   vault_mint  :', vaultMintPda.toBase58());
  console.log('');

  // ── 3. Resolve usdc_vault ATA address (created by program in TX 2) ───────
  const usdcVault = await getAssociatedTokenAddress(factory.usdcMint, vaultPda, true);
  console.log('💵 usdc_vault ATA:', usdcVault.toBase58(), '(will be created)\n');

  // ── 4. TX 1: create_vault ────────────────────────────────────────────────
  console.log('📤 [1/2] Sending create_vault...');
  const tx1 = new Transaction().add(buildCreateVaultIx(
    {
      leader:       keypair.publicKey,
      factoryState: factoryPda,
      vaultState:   vaultPda,
      tradingState: tradingPda,
    },
    {
      name:              VAULT_NAME,
      symbol:            VAULT_SYMBOL,
      performanceFeeBps: BigInt(Math.round(PERFORMANCE_FEE_PERCENT * 100)),
    },
  ));

  let sig1;
  try {
    sig1 = await sendAndConfirmTransaction(connection, tx1, [keypair], {
      preflightCommitment: 'confirmed', commitment: 'confirmed',
    });
    console.log('   ✅', sig1);
  } catch (e) {
    console.error('   ❌', e.message);
    if (e.logs) e.logs.forEach((l) => console.error('     ', l));
    process.exit(1);
  }
  console.log('');

  // ── 5. TX 2: init_vault_assets (creates mint + usdc_vault ATA) ───────────
  console.log('📤 [2/2] Sending init_vault_assets...');
  const tx2 = new Transaction().add(buildInitVaultAssetsIx({
    leader:     keypair.publicKey,
    vaultState: vaultPda,
    vaultMint:  vaultMintPda,
    usdcVault:  usdcVault,
    usdcMint:   factory.usdcMint,
  }));

  let sig2;
  try {
    sig2 = await sendAndConfirmTransaction(connection, tx2, [keypair], {
      preflightCommitment: 'confirmed', commitment: 'confirmed',
    });
    console.log('   ✅', sig2);
  } catch (e) {
    console.error('   ❌', e.message);
    if (e.logs) e.logs.forEach((l) => console.error('     ', l));
    process.exit(1);
  }
  console.log('');

  console.log('🎉 Vault created successfully!');
  console.log('   vault_state :', vaultPda.toBase58());
  console.log('   vault_mint  :', vaultMintPda.toBase58());
  console.log('   usdc_vault  :', usdcVault.toBase58());
  console.log('   trading     :', tradingPda.toBase58());
  console.log('');
  console.log('🔗 Vault   : https://explorer.solana.com/address/' + vaultPda.toBase58() + '?cluster=devnet');
  console.log('🔗 Mint    : https://explorer.solana.com/address/' + vaultMintPda.toBase58() + '?cluster=devnet');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
