/**
 * Sell vault tokens for devnet USDC.
 *
 * Run from PowerShell:
 *   cd "C:\Users\user\Desktop\Git\HypersFun_SOL"
 *   node scripts/sell-test.mjs <VAULT_PDA> [TOKEN_AMOUNT]
 *
 * Example:
 *   node scripts/sell-test.mjs CshPqqNs8AP7vR13it24iPgHZjieZfRW9d1Khg62aRmg 5
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import fs from 'node:fs';

process.loadEnvFile('.env');

const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID);
const RPC        = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.devnet.solana.com';
const ID_JSON    = 'C:\\Users\\user\\Desktop\\Project\\HypersFun_Contract_Test\\id.json';

const VAULT_PDA_STR = process.argv[2];
const TOKEN_AMOUNT  = parseFloat(process.argv[3] ?? '5');
if (!VAULT_PDA_STR) {
  console.error('Usage: node scripts/sell-test.mjs <VAULT_PDA> [TOKEN_AMOUNT]');
  process.exit(1);
}

const disc       = (n) => Buffer.from(sha256(`global:${n}`).slice(0, 8));
const enc_u64_le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };

const findFactoryPda   = ()      => PublicKey.findProgramAddressSync([Buffer.from('factory')], PROGRAM_ID);
const findUserVaultPda = (u, v) => PublicKey.findProgramAddressSync(
  [Buffer.from('user-vault'), u.toBuffer(), v.toBuffer()], PROGRAM_ID,
);

function parseVaultState(data) {
  const d = data.subarray(8);
  return {
    vaultMint: new PublicKey(d.subarray(128, 160)),
    usdcVault: new PublicKey(d.subarray(160, 192)),
    paused:    d.readUInt8(296) !== 0,
    vaultId:   d.readBigUInt64LE(646),
  };
}

function parseFactory(data) {
  const d = data.subarray(8);
  return { usdcMint: new PublicKey(d.subarray(64, 96)) };
}

function buildSellIx(accs, tokens, minUsdcOut = 0n) {
  const data = Buffer.concat([disc('sell'), enc_u64_le(tokens), enc_u64_le(minUsdcOut)]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accs.user,             isSigner: true,  isWritable: true  },
      { pubkey: accs.factoryState,     isSigner: false, isWritable: false },
      { pubkey: accs.vaultState,       isSigner: false, isWritable: true  },
      { pubkey: accs.userVaultState,   isSigner: false, isWritable: true  },
      { pubkey: accs.vaultMint,        isSigner: false, isWritable: true  },
      { pubkey: accs.userTokenAccount, isSigner: false, isWritable: true  },
      { pubkey: accs.usdcVault,        isSigner: false, isWritable: true  },
      { pubkey: accs.userUsdc,         isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function main() {
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(ID_JSON, 'utf-8'))),
  );
  const user = keypair.publicKey;
  const connection = new Connection(RPC, 'confirmed');

  console.log('🔍 User:', user.toBase58());

  const vaultPda = new PublicKey(VAULT_PDA_STR);
  const vaultAcc = await connection.getAccountInfo(vaultPda);
  if (!vaultAcc) { console.error('❌ Vault not found'); process.exit(1); }
  const v = parseVaultState(vaultAcc.data);
  console.log('🏛️  Vault:', vaultPda.toBase58(), 'id =', v.vaultId.toString());

  const [factoryPda] = findFactoryPda();
  const factoryAcc = await connection.getAccountInfo(factoryPda);
  const factory = parseFactory(factoryAcc.data);

  const [userVaultPda] = findUserVaultPda(user, vaultPda);
  const userUsdc         = await getAssociatedTokenAddress(factory.usdcMint, user);
  const userTokenAccount = await getAssociatedTokenAddress(v.vaultMint, user);

  // Check current balances
  const tokAcc  = await getAccount(connection, userTokenAccount);
  const usdcAcc = await getAccount(connection, userUsdc);
  const balTok  = Number(tokAcc.amount) / 1e9;
  const balUsdc = Number(usdcAcc.amount) / 1e6;
  console.log(`   user vault tokens : ${balTok}`);
  console.log(`   user USDC         : ${balUsdc}`);
  console.log('');
  if (balTok < TOKEN_AMOUNT) {
    console.error(`❌ Insufficient tokens. Have ${balTok}, want to sell ${TOKEN_AMOUNT}`);
    process.exit(1);
  }

  const tokenLamports = BigInt(Math.round(TOKEN_AMOUNT * 1_000_000_000));
  console.log(`📤 sell(${TOKEN_AMOUNT} tokens = ${tokenLamports} u-tok)...`);
  const tx = new Transaction().add(buildSellIx({
    user,
    factoryState:     factoryPda,
    vaultState:       vaultPda,
    userVaultState:   userVaultPda,
    vaultMint:        v.vaultMint,
    userTokenAccount,
    usdcVault:        v.usdcVault,
    userUsdc,
  }, tokenLamports, 0n));

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    console.log('   ✅', sig);
    console.log('');

    const newTok  = Number((await getAccount(connection, userTokenAccount)).amount) / 1e9;
    const newUsdc = Number((await getAccount(connection, userUsdc)).amount) / 1e6;
    console.log('🎉 Sold!');
    console.log(`   tokens:  ${balTok} → ${newTok}  (Δ ${(balTok - newTok).toFixed(4)})`);
    console.log(`   USDC  :  ${balUsdc} → ${newUsdc}  (Δ +${(newUsdc - balUsdc).toFixed(4)})`);
    console.log('   tx: https://explorer.solana.com/tx/' + sig + '?cluster=devnet');
  } catch (e) {
    console.error('❌ sell() failed:', e.message);
    if (e.logs) e.logs.forEach((l) => console.error('  ', l));
    process.exit(1);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
