/**
 * Buy vault tokens with devnet USDC.
 *
 * Run from PowerShell:
 *   cd "C:\Users\user\Desktop\Git\HypersFun_SOL"
 *   node scripts/buy-test.mjs <VAULT_PDA> [USDC_AMOUNT]
 *
 * Example:
 *   node scripts/buy-test.mjs CshPqqNs8AP7vR13it24iPgHZjieZfRW9d1Khg62aRmg 5
 *
 * The script will:
 *   1. Read vault state
 *   2. Pre-create user_usdc ATA (Circle USDC) if missing — fund from
 *      https://faucet.circle.com/  (Solana Devnet)
 *   3. Pre-create user_token_account ATA (vault share mint) if missing
 *   4. Call init_user_vault_state if not already created
 *   5. Send buy(usdc_amount, min_tokens_out=0)
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  getAccount, TokenAccountNotFoundError, TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import fs from 'node:fs';

process.loadEnvFile('.env');

// ─── Config ──────────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID);
const RPC        = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.devnet.solana.com';
const ID_JSON    = 'C:\\Users\\user\\Desktop\\Project\\HypersFun_Contract_Test\\id.json';

const VAULT_PDA_STR = process.argv[2];
const USDC_AMOUNT   = parseFloat(process.argv[3] ?? '5'); // default 5 USDC
if (!VAULT_PDA_STR) {
  console.error('Usage: node scripts/buy-test.mjs <VAULT_PDA> [USDC_AMOUNT]');
  process.exit(1);
}

// ─── Encoders ────────────────────────────────────────────────────────────────
const disc       = (n) => Buffer.from(sha256(`global:${n}`).slice(0, 8));
const enc_u64_le = (n) => { const b = Buffer.alloc(8);  b.writeBigUInt64LE(BigInt(n), 0); return b; };

// ─── PDAs ────────────────────────────────────────────────────────────────────
const findFactoryPda      = ()      => PublicKey.findProgramAddressSync([Buffer.from('factory')], PROGRAM_ID);
const findVaultPda        = (id)    => PublicKey.findProgramAddressSync([Buffer.from('vault'), enc_u64_le(id)], PROGRAM_ID);
const findUserVaultPda    = (user, vault) => PublicKey.findProgramAddressSync(
  [Buffer.from('user-vault'), user.toBuffer(), vault.toBuffer()], PROGRAM_ID,
);

// ─── Reads ───────────────────────────────────────────────────────────────────
function parseVaultState(data) {
  const d = data.subarray(8);
  return {
    factory:      new PublicKey(d.subarray(0, 32)),
    leader:       new PublicKey(d.subarray(32, 64)),
    admin:        new PublicKey(d.subarray(64, 96)),
    tradingState: new PublicKey(d.subarray(96, 128)),
    vaultMint:    new PublicKey(d.subarray(128, 160)),
    usdcVault:    new PublicKey(d.subarray(160, 192)),
    feeBps:       d.readBigUInt64LE(192),
    paused:       d.readUInt8(296) !== 0,
    vaultId:      d.readBigUInt64LE(646),
  };
}

function parseFactory(data) {
  const d = data.subarray(8);
  return {
    treasury: new PublicKey(d.subarray(32, 64)),
    usdcMint: new PublicKey(d.subarray(64, 96)),
  };
}

// ─── Build instructions ──────────────────────────────────────────────────────
function buildInitUserVaultStateIx(user, vaultState, userVaultState) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user,                    isSigner: true,  isWritable: true  },
      { pubkey: vaultState,              isSigner: false, isWritable: false },
      { pubkey: userVaultState,          isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc('init_user_vault_state'),
  });
}

function buildBuyIx(accs, usdcAmount, minTokensOut = 0n) {
  const data = Buffer.concat([
    disc('buy'),
    enc_u64_le(usdcAmount),
    enc_u64_le(minTokensOut),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accs.user,            isSigner: true,  isWritable: true  },
      { pubkey: accs.factoryState,    isSigner: false, isWritable: false },
      { pubkey: accs.vaultState,      isSigner: false, isWritable: true  },
      { pubkey: accs.userVaultState,  isSigner: false, isWritable: true  },
      { pubkey: accs.vaultMint,       isSigner: false, isWritable: true  },
      { pubkey: accs.userTokenAccount,isSigner: false, isWritable: true  },
      { pubkey: accs.usdcVault,       isSigner: false, isWritable: true  },
      { pubkey: accs.userUsdc,        isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Helper ──────────────────────────────────────────────────────────────────
async function ataIfMissing(connection, payer, mint, owner) {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  try {
    await getAccount(connection, ata);
    return { ata, ix: null, exists: true };
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError || e instanceof TokenInvalidAccountOwnerError) {
      return { ata, ix: createAssociatedTokenAccountInstruction(payer, ata, owner, mint), exists: false };
    }
    throw e;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(ID_JSON, 'utf-8'))),
  );
  const user = keypair.publicKey;
  const connection = new Connection(RPC, 'confirmed');

  console.log('🔍 User:', user.toBase58());
  console.log('   SOL :', (await connection.getBalance(user)) / LAMPORTS_PER_SOL);
  console.log('');

  // ── Read vault ──
  const vaultPda = new PublicKey(VAULT_PDA_STR);
  const vaultAcc = await connection.getAccountInfo(vaultPda);
  if (!vaultAcc) { console.error('❌ Vault not found:', VAULT_PDA_STR); process.exit(1); }
  const vault = parseVaultState(vaultAcc.data);
  console.log('🏛️  Vault:', vaultPda.toBase58());
  console.log('   id            :', vault.vaultId.toString());
  console.log('   leader        :', vault.leader.toBase58());
  console.log('   vault_mint    :', vault.vaultMint.toBase58());
  console.log('   usdc_vault    :', vault.usdcVault.toBase58());
  console.log('   paused        :', vault.paused);
  if (vault.paused) { console.error('❌ Vault paused'); process.exit(1); }
  if (vault.vaultMint.equals(PublicKey.default) || vault.usdcVault.equals(PublicKey.default)) {
    console.error('❌ Vault assets not initialized — call init_vault_assets first');
    process.exit(1);
  }
  console.log('');

  // ── Read factory ──
  const [factoryPda] = findFactoryPda();
  const factoryAcc = await connection.getAccountInfo(factoryPda);
  if (!factoryAcc) { console.error('❌ Factory not initialized'); process.exit(1); }
  const factory = parseFactory(factoryAcc.data);
  console.log('🏭 Factory:', factoryPda.toBase58());
  console.log('   usdc_mint:', factory.usdcMint.toBase58());
  console.log('');

  // ── Resolve all accounts ──
  const [userVaultPda] = findUserVaultPda(user, vaultPda);

  const userUsdcRes  = await ataIfMissing(connection, user, factory.usdcMint, user);
  const userVtokRes  = await ataIfMissing(connection, user, vault.vaultMint, user);

  console.log('💰 user_usdc      :', userUsdcRes.ata.toBase58(), userUsdcRes.exists ? '✅' : '(create)');
  if (userUsdcRes.exists) {
    const acc = await getAccount(connection, userUsdcRes.ata);
    const balUsdc = Number(acc.amount) / 1_000_000;
    console.log('   USDC balance:', balUsdc, 'USDC');
    if (balUsdc < USDC_AMOUNT) {
      console.error(`❌ Insufficient USDC. Need ${USDC_AMOUNT}, have ${balUsdc}.`);
      console.error('   Get devnet USDC: https://faucet.circle.com/  (select Solana Devnet)');
      process.exit(1);
    }
  } else {
    console.error('❌ No user USDC ATA. Create + fund first:');
    console.error('   1. Tx will create the ATA');
    console.error('   2. Fund from https://faucet.circle.com/  (Solana Devnet)');
    console.error('   3. Re-run this script');
  }
  console.log('🪙 user_vault_tok :', userVtokRes.ata.toBase58(), userVtokRes.exists ? '✅' : '(create)');
  console.log('🗂️  user_vault    :', userVaultPda.toBase58());

  const userVaultExists = (await connection.getAccountInfo(userVaultPda)) !== null;
  console.log('   exists        :', userVaultExists);
  console.log('');

  // ── TX 0: ensure user ATAs exist (USDC + vault token) ──
  const setupIxs = [];
  if (!userUsdcRes.exists) setupIxs.push(userUsdcRes.ix);
  if (!userVtokRes.exists) setupIxs.push(userVtokRes.ix);

  if (setupIxs.length > 0) {
    console.log('📤 [setup] creating ATAs...');
    const tx = new Transaction().add(...setupIxs);
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    console.log('   ✅', sig);
    console.log('');
    if (!userUsdcRes.exists) {
      console.log('⚠️  user_usdc was just created and is empty. Fund it with devnet USDC:');
      console.log('   https://faucet.circle.com/  (Solana Devnet)');
      console.log('   Address:', user.toBase58());
      console.log('   Then re-run this script.');
      process.exit(0);
    }
  }

  // ── TX 1: init_user_vault_state if needed ──
  if (!userVaultExists) {
    console.log('📤 [1/2] init_user_vault_state...');
    const tx = new Transaction().add(buildInitUserVaultStateIx(user, vaultPda, userVaultPda));
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    console.log('   ✅', sig);
    console.log('');
  }

  // ── TX 2: buy ──
  const usdcLamports = BigInt(Math.round(USDC_AMOUNT * 1_000_000));
  console.log(`📤 [2/2] buy(${USDC_AMOUNT} USDC = ${usdcLamports} u-USDC)...`);
  const tx = new Transaction().add(buildBuyIx({
    user,
    factoryState:     factoryPda,
    vaultState:       vaultPda,
    userVaultState:   userVaultPda,
    vaultMint:        vault.vaultMint,
    userTokenAccount: userVtokRes.ata,
    usdcVault:        vault.usdcVault,
    userUsdc:         userUsdcRes.ata,
  }, usdcLamports, 0n));

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    console.log('   ✅', sig);
    console.log('');

    // Check vault token balance
    const acc = await getAccount(connection, userVtokRes.ata);
    const balTok = Number(acc.amount) / 1_000_000_000;
    console.log('🎉 Bought!');
    console.log('   vault tokens received:', balTok);
    console.log('   tx: https://explorer.solana.com/tx/' + sig + '?cluster=devnet');
  } catch (e) {
    console.error('❌ buy() failed:', e.message);
    if (e.logs) e.logs.forEach((l) => console.error('  ', l));
    process.exit(1);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
