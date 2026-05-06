/**
 * HyperFun program helpers — raw web3.js (no Anchor SDK needed).
 *
 * Anchor instruction layout:
 *   [8-byte discriminator: sha256("global:<fn_name>")[..8]] [borsh-encoded args]
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import { PROGRAM_ID, USDC_MINT } from './config';

// ─── Discriminator helper ────────────────────────────────────────────────────
function disc(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}

// ─── Borsh-style encoders ────────────────────────────────────────────────────
function enc_string(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function enc_u64_le(n: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n), 0);
  return buf;
}

function enc_u128_le(n: bigint | number): Buffer {
  const v = BigInt(n);
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(v & 0xFFFFFFFFFFFFFFFFn, 0);
  buf.writeBigUInt64LE(v >> 64n, 8);
  return buf;
}

// ─── PDA helpers ─────────────────────────────────────────────────────────────
export function findFactoryPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('factory')], PROGRAM_ID);
}

export function findVaultPda(vaultId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), enc_u64_le(vaultId)],
    PROGRAM_ID,
  );
}

export function findTradingPda(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('trading'), vault.toBuffer()],
    PROGRAM_ID,
  );
}

export function findVaultMintPda(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault-mint'), vault.toBuffer()],
    PROGRAM_ID,
  );
}

// ─── Factory state read (only fields we need) ────────────────────────────────
export interface FactoryStateLite {
  authority: PublicKey;
  treasury: PublicKey;
  usdcMint: PublicKey;
  creationFee: bigint;       // u64 USDC (6 dec)
  paused: boolean;
  vaultCount: bigint;        // u64
}

/**
 * Decodes only the leading bytes we need from FactoryState.
 * Layout (offset from start, after 8-byte discriminator):
 *   0:   authority         32
 *   32:  treasury          32
 *   64:  usdc_mint         32
 *   96:  creation_fee      8  (u64)
 *   ... we then skip to vault_count (near the end)
 *
 * vault_count + paused are near the end — we read by walking from the start.
 * For robustness we re-parse all fixed-size segments.
 */
export async function fetchFactoryState(
  connection: Connection,
): Promise<FactoryStateLite | null> {
  const [factoryPda] = findFactoryPda();
  const acc = await connection.getAccountInfo(factoryPda);
  if (!acc) return null;

  const data = acc.data.subarray(8); // strip Anchor discriminator
  const authority   = new PublicKey(data.subarray(0, 32));
  const treasury    = new PublicKey(data.subarray(32, 64));
  const usdcMint    = new PublicKey(data.subarray(64, 96));
  const creationFee = data.readBigUInt64LE(96);

  // Walk to paused + vault_count fields.
  // FactoryState layout (in order, in bytes from offset 0):
  //   96 + 8 (creation_fee)
  //   + 16+16+16 (default bc) = 48
  //   + 32 (default_builder)
  //   + 8 (default_builder_fee_rate)
  //   + 8*9 (9 global u64) = 72
  //   + 16+16 (nav virtual a/s) = 32
  //   + 1 (exit_fee_enabled)
  //   + 8 (bc_virtual_minimum_bps)
  //   + 1 (nav_virtual_mode)
  //   + 8 (multiplier_bps)
  //   + 16 (minimum)
  //   + 8 (max_multiplier_bps)
  //   + 16 (target_assets)
  //   + 8 (max_bc_ratio_bps)
  //   + 1 (graduation_tiered_mode)
  //   + 560 (graduation_tiers [10×56])
  //   + 1 (graduation_tier_count)
  //   + 160 (exit_fee_tiers [10×16])
  //   + 1 (exit_fee_tier_count)
  //   → next is paused (1 byte), vault_count (8), bump (1)
  let off = 96 + 8 + 48 + 32 + 8 + 72 + 32 + 1 + 8 + 1 + 8 + 16 + 8 + 16 + 8 + 1 + 560 + 1 + 160 + 1;
  const paused = data.readUInt8(off) !== 0; off += 1;
  const vaultCount = data.readBigUInt64LE(off);

  return { authority, treasury, usdcMint, creationFee, paused, vaultCount };
}

// ─── VaultState account read ─────────────────────────────────────────────────
//
// On-chain layout (byte offsets from the start of account data, after the
// 8-byte Anchor discriminator):
//
//   0   factory            Pubkey   (32)
//   32  leader             Pubkey   (32)
//   64  admin              Pubkey   (32)
//   96  trading_state      Pubkey   (32)
//   128 vault_mint         Pubkey   (32)
//   160 usdc_vault         Pubkey   (32)
//   192 fee_bps            u64      (8)
//   200 virtual_base       u128     (16)
//   216 virtual_tokens     u128     (16)
//   232 initial_assets     u128     (16)
//   248 total_deposits     u128     (16)
//   264 total_volume       u128     (16)
//   280 total_ps_usdc      u64      (8)
//   288 protocol_fee       u64      (8)
//   296 paused             bool     (1)
//   297 name               [u8;64]  (64)
//   361 name_len           u8       (1)
//   362 symbol             [u8;16]  (16)
//   378 symbol_len         u8       (1)
//   379 metadata_uri       [u8;256] (256)
//   635 metadata_uri_len   u16      (2)
//   637 verified           bool     (1)
//   638 created_at         i64      (8)
//   646 vault_id           u64      (8)
//   654 twap_nav           u128     (16)
//   670 twap_nav_time      i64      (8)
//   678 twap_max_change... u64      (8)

export interface VaultStateData {
  pubkey:       PublicKey;
  factory:      PublicKey;
  leader:       PublicKey;
  admin:        PublicKey;
  tradingState: PublicKey;
  vaultMint:    PublicKey;
  usdcVault:    PublicKey;
  feeBps:           bigint;   // performance fee bps
  virtualBase:      bigint;
  virtualTokens:    bigint;
  initialAssets:    bigint;
  totalDeposits:    bigint;
  totalVolume:      bigint;
  totalPsUsdc:      bigint;
  protocolFee:      bigint;
  paused:           boolean;
  name:             string;
  symbol:           string;
  metadataUri:      string;
  verified:         boolean;
  createdAt:        number;   // unix seconds
  vaultId:          bigint;
  twapNav:          bigint;
  twapNavTime:      number;
  twapMaxChangePerMin: bigint;
}

function readU128LE(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off) | (buf.readBigUInt64LE(off + 8) << 64n);
}

export function parseVaultState(raw: Buffer, pubkey: PublicKey): VaultStateData {
  const d = raw.subarray(8); // strip Anchor discriminator
  let o = 0;
  const factory      = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const leader       = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const admin        = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const tradingState = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const vaultMint    = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const usdcVault    = new PublicKey(d.subarray(o, o + 32)); o += 32;

  const feeBps         = d.readBigUInt64LE(o); o += 8;
  const virtualBase    = readU128LE(d, o); o += 16;
  const virtualTokens  = readU128LE(d, o); o += 16;
  const initialAssets  = readU128LE(d, o); o += 16;
  const totalDeposits  = readU128LE(d, o); o += 16;
  const totalVolume    = readU128LE(d, o); o += 16;
  const totalPsUsdc    = d.readBigUInt64LE(o); o += 8;
  const protocolFee    = d.readBigUInt64LE(o); o += 8;
  const paused         = d.readUInt8(o) !== 0; o += 1;

  const nameRaw   = d.subarray(o, o + 64); o += 64;
  const nameLen   = d.readUInt8(o); o += 1;
  const symbolRaw = d.subarray(o, o + 16); o += 16;
  const symbolLen = d.readUInt8(o); o += 1;
  const uriRaw    = d.subarray(o, o + 256); o += 256;
  const uriLen    = d.readUInt16LE(o); o += 2;

  const verified  = d.readUInt8(o) !== 0; o += 1;
  const createdAt = Number(d.readBigInt64LE(o)); o += 8;
  const vaultId   = d.readBigUInt64LE(o); o += 8;

  const twapNav             = readU128LE(d, o); o += 16;
  const twapNavTime         = Number(d.readBigInt64LE(o)); o += 8;
  const twapMaxChangePerMin = d.readBigUInt64LE(o);

  return {
    pubkey,
    factory, leader, admin, tradingState, vaultMint, usdcVault,
    feeBps, virtualBase, virtualTokens, initialAssets,
    totalDeposits, totalVolume, totalPsUsdc,
    protocolFee, paused,
    name:        nameRaw.subarray(0, nameLen).toString('utf-8'),
    symbol:      symbolRaw.subarray(0, symbolLen).toString('utf-8'),
    metadataUri: uriRaw.subarray(0, uriLen).toString('utf-8'),
    verified, createdAt, vaultId,
    twapNav, twapNavTime, twapMaxChangePerMin,
  };
}

/**
 * Fetch a single vault by its PDA.
 */
export async function fetchVaultState(
  connection: Connection,
  vaultPda: PublicKey,
): Promise<VaultStateData | null> {
  const acc = await connection.getAccountInfo(vaultPda);
  if (!acc) return null;
  return parseVaultState(acc.data, vaultPda);
}

/**
 * Fetch a vault by its 0-based id (uses the same PDA derivation as create_vault).
 */
export async function fetchVaultById(
  connection: Connection,
  vaultId: bigint | number,
): Promise<VaultStateData | null> {
  const [pda] = findVaultPda(BigInt(vaultId));
  return fetchVaultState(connection, pda);
}

/**
 * Load every vault that the factory has created.
 *
 * Walks 0..vault_count and batch-reads the PDAs via getMultipleAccountsInfo
 * (single RPC call up to 100 accounts).
 */
export async function loadAllVaults(connection: Connection): Promise<VaultStateData[]> {
  const factory = await fetchFactoryState(connection);
  if (!factory) return [];

  const count = Number(factory.vaultCount);
  if (count === 0) return [];

  const pdas: PublicKey[] = [];
  for (let i = 0; i < count; i++) pdas.push(findVaultPda(BigInt(i))[0]);

  // Solana RPC caps getMultipleAccountsInfo at 100 keys per call
  const out: VaultStateData[] = [];
  for (let i = 0; i < pdas.length; i += 100) {
    const slice = pdas.slice(i, i + 100);
    const accs = await connection.getMultipleAccountsInfo(slice);
    accs.forEach((a, j) => {
      if (a) out.push(parseVaultState(a.data, slice[j]));
    });
  }
  return out;
}

// ─── Instruction: initialize_factory ─────────────────────────────────────────
export interface InitializeFactoryArgs {
  treasury: PublicKey;
}

export function buildInitializeFactoryIx(
  authority: PublicKey,
  args: InitializeFactoryArgs,
  usdcMint: PublicKey = USDC_MINT,
): TransactionInstruction {
  const [factoryPda] = findFactoryPda();

  // Args: FactoryInitParams { treasury: Pubkey }
  const data = Buffer.concat([
    disc('initialize_factory'),
    args.treasury.toBuffer(),
  ]);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority,   isSigner: true,  isWritable: true  },
      { pubkey: factoryPda,  isSigner: false, isWritable: true  },
      { pubkey: usdcMint,    isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Instruction: create_vault (TX 1 of 2) ───────────────────────────────────
export interface CreateVaultArgs {
  name: string;
  symbol: string;
  performanceFeeBps: bigint | number; // u64
  bcVirtualBase?: bigint | number;    // u128, 0 = factory default
  bcVirtualTokens?: bigint | number;  // u128, 0 = factory default
  initialAssets?: bigint | number;    // u128, 0 = factory default
}

export interface CreateVaultAccounts {
  leader: PublicKey;
  factoryState: PublicKey;
  vaultState: PublicKey;
  tradingState: PublicKey;
}

export function buildCreateVaultIx(
  accounts: CreateVaultAccounts,
  args: CreateVaultArgs,
): TransactionInstruction {
  const data = Buffer.concat([
    disc('create_vault'),
    enc_string(args.name),
    enc_string(args.symbol),
    enc_u64_le(args.performanceFeeBps),
    enc_u128_le(args.bcVirtualBase ?? 0),
    enc_u128_le(args.bcVirtualTokens ?? 0),
    enc_u128_le(args.initialAssets ?? 0),
  ]);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.leader,         isSigner: true,  isWritable: true  },
      { pubkey: accounts.factoryState,   isSigner: false, isWritable: true  },
      { pubkey: accounts.vaultState,     isSigner: false, isWritable: true  },
      { pubkey: accounts.tradingState,   isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Instruction: init_vault_assets (TX 2 of 2 — creates Mint + USDC ATA) ────
export interface InitVaultAssetsAccounts {
  leader: PublicKey;
  vaultState: PublicKey;
  vaultMint: PublicKey;
  usdcVault: PublicKey;
  usdcMint: PublicKey;
}

export function buildInitVaultAssetsIx(
  accounts: InitVaultAssetsAccounts,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.leader,        isSigner: true,  isWritable: true  },
      { pubkey: accounts.vaultState,    isSigner: false, isWritable: true  },
      { pubkey: accounts.vaultMint,     isSigner: false, isWritable: true  },
      { pubkey: accounts.usdcVault,     isSigner: false, isWritable: true  },
      { pubkey: accounts.usdcMint,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,            isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,     isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,          isSigner: false, isWritable: false },
    ],
    data: disc('init_vault_assets'),
  });
}

// ─── Instruction: set_metadata_uri (TX 3 — leader writes metadata URI) ───────
//
// Mirrors the EVM `setMetadataURI(string)` setter from HyperFunFactory guide.
// Anchor convention: snake-case method name, args = String (borsh: u32 LE len
// + utf-8 bytes). Max length on-chain is 256 bytes (see VaultState layout).
//
// If the deployed program uses a different name, change `set_metadata_uri`
// below and the wrapper in app/launch/page.tsx will pick it up.
export interface SetMetadataUriAccounts {
  leader: PublicKey;
  vaultState: PublicKey;
}

export function buildSetMetadataUriIx(
  accounts: SetMetadataUriAccounts,
  uri: string,
): TransactionInstruction {
  if (Buffer.byteLength(uri, 'utf-8') > 256) {
    throw new Error('metadata_uri exceeds on-chain max of 256 bytes');
  }
  const data = Buffer.concat([disc('set_metadata_uri'), enc_string(uri)]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.leader,     isSigner: true,  isWritable: true },
      { pubkey: accounts.vaultState, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Resolve PDAs + ATA addresses needed for the 2-step create-vault flow.
 * Reads factory state to get the next vault_id.
 */
export async function prepareCreateVaultAccounts(
  connection: Connection,
  leader: PublicKey,
): Promise<{
  vaultId: bigint;
  factory: FactoryStateLite;
  createVault: CreateVaultAccounts;
  initAssets: InitVaultAssetsAccounts;
}> {
  const factory = await fetchFactoryState(connection);
  if (!factory) {
    throw new Error('Factory not initialized — call initialize_factory first.');
  }

  const [factoryPda]   = findFactoryPda();
  const [vaultPda]     = findVaultPda(factory.vaultCount);
  const [tradingPda]   = findTradingPda(vaultPda);
  const [vaultMintPda] = findVaultMintPda(vaultPda);
  const usdcVault      = await getAssociatedTokenAddress(factory.usdcMint, vaultPda, true);

  return {
    vaultId: factory.vaultCount,
    factory,
    createVault: {
      leader,
      factoryState: factoryPda,
      vaultState: vaultPda,
      tradingState: tradingPda,
    },
    initAssets: {
      leader,
      vaultState: vaultPda,
      vaultMint: vaultMintPda,
      usdcVault,
      usdcMint: factory.usdcMint,
    },
  };
}
