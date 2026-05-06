/**
 * Probe devnet for vaults + their metadata. Run:
 *   node scripts/probe-vaults.mjs
 */
import { Connection, PublicKey } from '@solana/web3.js';

process.loadEnvFile('.env');

const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID);
const RPC        = 'https://api.devnet.solana.com';
const GATEWAY    = 'https://cyan-defeated-lemming-99.mypinata.cloud/ipfs/';

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };
const findFactory = () => PublicKey.findProgramAddressSync([Buffer.from('factory')], PROGRAM_ID);
const findVault   = (id) => PublicKey.findProgramAddressSync([Buffer.from('vault'), u64(id)], PROGRAM_ID);

function parseFactory(data) {
  const d = data.subarray(8);
  let off = 96 + 8 + 48 + 32 + 8 + 72 + 32 + 1 + 8 + 1 + 8 + 16 + 8 + 16 + 8 + 1 + 560 + 1 + 160 + 1;
  const paused     = d.readUInt8(off) !== 0; off += 1;
  const vaultCount = d.readBigUInt64LE(off);
  return { paused, vaultCount };
}

function parseVault(raw, pubkey) {
  const d = raw.subarray(8);
  let o = 0;
  const factory      = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const leader       = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const admin        = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const tradingState = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const vaultMint    = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const usdcVault    = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const feeBps       = d.readBigUInt64LE(o); o += 8;
  o += 16 * 5;            // virtualBase, virtualTokens, initialAssets, totalDeposits, totalVolume
  o += 8 + 8 + 1;         // total_ps_usdc, protocol_fee, paused
  const nameRaw   = d.subarray(o, o + 64); o += 64;
  const nameLen   = d.readUInt8(o); o += 1;
  const symbolRaw = d.subarray(o, o + 16); o += 16;
  const symbolLen = d.readUInt8(o); o += 1;
  const uriRaw    = d.subarray(o, o + 256); o += 256;
  const uriLen    = d.readUInt16LE(o); o += 2;
  const verified  = d.readUInt8(o) !== 0; o += 1;
  const createdAt = Number(d.readBigInt64LE(o)); o += 8;
  const vaultId   = d.readBigUInt64LE(o);
  return {
    pubkey:      pubkey.toBase58(),
    vaultId:     vaultId.toString(),
    leader:      leader.toBase58(),
    feeBps:      feeBps.toString(),
    name:        nameRaw.subarray(0, nameLen).toString('utf-8'),
    symbol:      symbolRaw.subarray(0, symbolLen).toString('utf-8'),
    metadataUri: uriRaw.subarray(0, uriLen).toString('utf-8'),
    uriLen,
    verified,
    createdAt,
  };
}

async function fetchIpfs(uri) {
  if (!uri || !uri.startsWith('ipfs://')) return null;
  const hash = uri.replace('ipfs://', '');
  try {
    const res = await fetch(GATEWAY + hash, { cache: 'no-store' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: String(e) };
  }
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');

  const [factoryPda] = findFactory();
  console.log('Factory PDA:', factoryPda.toBase58());

  const factoryAcc = await conn.getAccountInfo(factoryPda);
  if (!factoryAcc) { console.log('❌ Factory not initialized'); return; }

  const factory = parseFactory(factoryAcc.data);
  console.log('vaultCount:', factory.vaultCount.toString(), '| paused:', factory.paused);

  const count = Number(factory.vaultCount);
  if (count === 0) { console.log('No vaults yet.'); return; }

  const pdas = [];
  for (let i = 0; i < count; i++) pdas.push(findVault(i)[0]);
  const accs = await conn.getMultipleAccountsInfo(pdas);

  const vaults = [];
  accs.forEach((a, i) => { if (a) vaults.push(parseVault(a.data, pdas[i])); });

  console.log(`\nFound ${vaults.length} vault(s):\n`);
  for (const v of vaults) {
    console.log(`  #${v.vaultId} ${v.name} (${v.symbol})`);
    console.log(`    pubkey:    ${v.pubkey}`);
    console.log(`    leader:    ${v.leader}`);
    console.log(`    feeBps:    ${v.feeBps}`);
    console.log(`    verified:  ${v.verified}  createdAt: ${v.createdAt}`);
    console.log(`    uriLen:    ${v.uriLen}`);
    console.log(`    metadata:  ${v.metadataUri || '(empty)'}`);
    if (v.metadataUri) {
      const json = await fetchIpfs(v.metadataUri);
      console.log(`    ↳ JSON:    ${JSON.stringify(json)}`);
    }
    console.log('');
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
