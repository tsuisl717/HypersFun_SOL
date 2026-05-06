/**
 * Fetch Anchor IDL from on-chain for the deployed HyperFun program.
 *
 *   node scripts/fetch-idl.mjs
 *
 * Anchor stores the IDL at a deterministic PDA:
 *   base = createProgramAddress([], programId).0
 *   idlPda = createWithSeed(base, "anchor:idl", programId)
 *
 * The account stores: 8-byte disc + 32 authority + 4-byte len + zlib-compressed JSON.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import zlib from 'node:zlib';
import fs from 'node:fs';

process.loadEnvFile('.env');
const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID);
const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.devnet.solana.com';

const connection = new Connection(RPC, 'confirmed');

// Anchor IDL PDA
const [base] = await PublicKey.findProgramAddress([], PROGRAM_ID);
const idlPda = await PublicKey.createWithSeed(base, 'anchor:idl', PROGRAM_ID);
console.log('Program ID :', PROGRAM_ID.toBase58());
console.log('IDL PDA    :', idlPda.toBase58());

const acc = await connection.getAccountInfo(idlPda);
if (!acc) {
  console.error('❌ No IDL account on chain (program was deployed without `anchor idl init`).');
  process.exit(1);
}

// Layout: 8 disc + 32 authority + 4 len + zlib(JSON)
const data = acc.data;
const len = data.readUInt32LE(40);
const compressed = data.subarray(44, 44 + len);
const json = zlib.inflateSync(compressed).toString('utf-8');
const idl = JSON.parse(json);

console.log('\nProgram name:', idl.name, 'v' + idl.version);
console.log('Instructions:', idl.instructions.map(i => i.name).join(', '));

const buy = idl.instructions.find(i => i.name === 'buy' || i.name === 'Buy');
if (!buy) {
  console.error('\n❌ No `buy` instruction in IDL. Available:', idl.instructions.map(i => i.name));
  process.exit(1);
}

console.log('\n=== buy instruction expected accounts (in order) ===');
buy.accounts.forEach((a, i) => {
  console.log(`  ${i.toString().padStart(2)}. ${a.name.padEnd(28)} signer=${!!a.isSigner} writable=${!!a.isMut}`);
});

console.log('\n=== buy instruction args ===');
buy.args.forEach(a => console.log(`  - ${a.name}: ${JSON.stringify(a.type)}`));

fs.writeFileSync('scripts/idl.json', JSON.stringify(idl, null, 2));
console.log('\n📝 Full IDL written to scripts/idl.json');
