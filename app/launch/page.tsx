'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Rocket, Loader2, ExternalLink, AlertTriangle, ImagePlus, Globe, Send, X } from 'lucide-react';
import {
  Connection,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

import Header from '@/components/Header';
import Footer from '@/components/Footer';
import Broadcast from '@/components/Broadcast';
import { SOLANA_CONFIG, PROGRAM_ID } from '@/lib/contracts/config';
import {
  fetchFactoryState,
  prepareCreateVaultAccounts,
  buildCreateVaultIx,
  buildInitVaultAssetsIx,
  buildInitializeFactoryIx,
  buildSetMetadataUriIx,
  type FactoryStateLite,
} from '@/lib/contracts/program';

const EXPLORER_BASE = `https://explorer.solana.com`;
const cluster = SOLANA_CONFIG.network === 'mainnet' ? '' : `?cluster=${SOLANA_CONFIG.network}`;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DESCRIPTION = 280;
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export default function LaunchPage() {
  const router = useRouter();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [factory, setFactory]       = useState<FactoryStateLite | null>(null);
  const [factoryLoaded, setFactoryLoaded] = useState(false);
  const [name, setName]             = useState('');
  const [symbol, setSymbol]         = useState('');
  const [feePct, setFeePct]         = useState('20');     // 20 % default
  const [description, setDescription] = useState('');
  const [imageFile, setImageFile]   = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [website, setWebsite]       = useState('');
  const [twitter, setTwitter]       = useState('');
  const [telegram, setTelegram]     = useState('');
  const [uploadStage, setUploadStage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg]         = useState<string | null>(null);
  const [result, setResult]         = useState<{
    sig1: string;
    sig2: string;
    sig3: string | null;
    metadataTxError: string | null;
    vaultPda: string;
    vaultMint: string;
    usdcVault: string;
    metadataUri: string | null;
  } | null>(null);

  // ── Image preview lifecycle ───────────────────────────────────────────────
  useEffect(() => {
    if (!imageFile) { setImagePreview(null); return; }
    const url = URL.createObjectURL(imageFile);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  const onPickImage = (f: File | null) => {
    setErrMsg(null);
    if (!f) { setImageFile(null); return; }
    if (!ACCEPTED_IMAGE_TYPES.includes(f.type)) {
      setErrMsg('Image must be PNG, JPG, WEBP, or GIF.');
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      setErrMsg('Image must be ≤ 5 MB.');
      return;
    }
    setImageFile(f);
  };

  const clearImage = () => {
    setImageFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Load factory state ─────────────────────────────────────────────────────
  const loadFactory = useCallback(async () => {
    setFactoryLoaded(false);
    try {
      const f = await fetchFactoryState(connection);
      setFactory(f);
    } catch (e) {
      console.error('fetchFactoryState failed', e);
    } finally {
      setFactoryLoaded(true);
    }
  }, [connection]);

  useEffect(() => { loadFactory(); }, [loadFactory]);

  // ── Initialize factory (one-time) ──────────────────────────────────────────
  const onInitFactory = async () => {
    if (!publicKey) return;
    setSubmitting(true);
    setErrMsg(null);
    try {
      const ix = buildInitializeFactoryIx(publicKey, { treasury: publicKey });
      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      await loadFactory();
    } catch (e: any) {
      setErrMsg(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Pinata upload helpers ─────────────────────────────────────────────────
  const uploadFileToIpfs = async (file: File): Promise<string> => {
    console.log('[uploadFileToIpfs] uploading file:', file.name, file.size, 'bytes');
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/pinata/upload', { method: 'POST', body: fd });
    console.log('[uploadFileToIpfs] response:', res.status, res.ok);
    if (!res.ok) {
      const text = await res.text();
      console.error('[uploadFileToIpfs] error body:', text);
      throw new Error(`Image upload failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    console.log('[uploadFileToIpfs] result:', json);
    if (!json.ipfsUrl) throw new Error('Image upload returned no ipfsUrl');
    return json.ipfsUrl as string;
  };

  const uploadJsonToIpfs = async (obj: unknown): Promise<string> => {
    console.log('[uploadJsonToIpfs] uploading JSON:', obj);
    const fd = new FormData();
    fd.append('metadata', JSON.stringify(obj));
    const res = await fetch('/api/pinata/upload', { method: 'POST', body: fd });
    console.log('[uploadJsonToIpfs] response:', res.status, res.ok);
    if (!res.ok) {
      const text = await res.text();
      console.error('[uploadJsonToIpfs] error body:', text);
      throw new Error(`Metadata upload failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    console.log('[uploadJsonToIpfs] result:', json);
    if (!json.ipfsUrl) throw new Error('Metadata upload returned no ipfsUrl');
    return json.ipfsUrl as string;
  };

  // ── Create vault ───────────────────────────────────────────────────────────
  const onCreate = async () => {
    if (!publicKey) return;
    if (!name.trim() || !symbol.trim()) {
      setErrMsg('Name and symbol are required.');
      return;
    }
    const fee = parseFloat(feePct);
    if (isNaN(fee) || fee < 0 || fee > 30) {
      setErrMsg('Performance fee must be 0 – 30 %.');
      return;
    }
    if (description.length > MAX_DESCRIPTION) {
      setErrMsg(`Description must be ≤ ${MAX_DESCRIPTION} characters.`);
      return;
    }

    setSubmitting(true);
    setErrMsg(null);
    setResult(null);

    try {
      // ── 0. Upload image + metadata to IPFS (if any provided) ──
      let imageIpfsUrl: string | null = null;
      let metadataUri: string | null = null;
      const links: Record<string, string> = {};
      if (website.trim())  links.website  = website.trim();
      if (twitter.trim())  links.twitter  = twitter.trim();
      if (telegram.trim()) links.telegram = telegram.trim();

      const hasMetadata = imageFile || description.trim() || Object.keys(links).length > 0;
      console.log('[onCreate] hasMetadata =', hasMetadata, '{ imageFile:', !!imageFile, ', description:', description.length, 'chars, links:', Object.keys(links).length, '}');
      if (hasMetadata) {
        if (imageFile) {
          setUploadStage('Uploading image to IPFS…');
          imageIpfsUrl = await uploadFileToIpfs(imageFile);
          console.log('[onCreate] imageIpfsUrl =', imageIpfsUrl);
        }
        setUploadStage('Uploading metadata to IPFS…');
        const metaJson = {
          name:        name.trim(),
          symbol:      symbol.trim().toUpperCase(),
          description: description.trim(),
          image:       imageIpfsUrl ?? '',
          links,
        };
        metadataUri = await uploadJsonToIpfs(metaJson);
        console.log('[onCreate] metadataUri =', metadataUri);
        setUploadStage(null);
      } else {
        console.log('[onCreate] no metadata to upload — skipping TX 3 set_metadata_uri');
      }

      const { createVault, initAssets } = await prepareCreateVaultAccounts(connection, publicKey);

      // ── TX 1: create_vault ──
      const tx1 = new Transaction().add(buildCreateVaultIx(createVault, {
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        performanceFeeBps: BigInt(Math.round(fee * 100)),
      }));
      const sig1 = await sendTransaction(tx1, connection);
      await connection.confirmTransaction(sig1, 'confirmed');

      // ── TX 2: init_vault_assets (creates SPL mint + USDC ATA) ──
      const tx2 = new Transaction().add(buildInitVaultAssetsIx(initAssets));
      const sig2 = await sendTransaction(tx2, connection);
      await connection.confirmTransaction(sig2, 'confirmed');

      // ── TX 3: set_metadata_uri (non-blocking — vault is already live) ──
      let sig3: string | null = null;
      let metadataTxError: string | null = null;
      if (metadataUri) {
        console.log('[onCreate] TX 3: writing metadata URI on-chain:', metadataUri);
        try {
          setUploadStage('Writing metadata URI on-chain…');
          const tx3 = new Transaction().add(buildSetMetadataUriIx(
            { leader: publicKey, vaultState: createVault.vaultState },
            metadataUri,
          ));
          sig3 = await sendTransaction(tx3, connection);
          console.log('[onCreate] TX 3 sent, sig:', sig3);
          await connection.confirmTransaction(sig3, 'confirmed');
          console.log('[onCreate] TX 3 confirmed ✅');
        } catch (e: any) {
          console.error('[onCreate] TX 3 set_metadata_uri FAILED:', e);
          if (e?.logs) console.error('[onCreate] TX 3 logs:', e.logs);
          metadataTxError = e?.message ?? String(e);
        }
      } else {
        console.log('[onCreate] no metadataUri — TX 3 skipped');
      }

      setResult({
        sig1,
        sig2,
        sig3,
        metadataTxError,
        vaultPda:  createVault.vaultState.toBase58(),
        vaultMint: initAssets.vaultMint.toBase58(),
        usdcVault: initAssets.usdcVault.toBase58(),
        metadataUri,
      });
      await loadFactory();
    } catch (e: any) {
      console.error(e);
      setErrMsg(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
      setUploadStage(null);
    }
  };

  // ── UI ─────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Broadcast />
      <Header searchQuery="" onSearchChange={() => {}} onLogoClick={() => router.push('/')} />

      <main className="flex-1 flex flex-col items-center px-4 py-12 gap-6">
        <div className="w-full max-w-lg space-y-6">

          {/* ── Title + status ── */}
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Rocket size={28} className="text-primary" />
              <h1 className="text-2xl font-black uppercase italic">Create a Vault</h1>
            </div>
            <p className="text-xs text-gray-500 font-mono">
              Program: <span className="text-primary">{PROGRAM_ID.toBase58().slice(0, 6)}…{PROGRAM_ID.toBase58().slice(-4)}</span>
              <span className="mx-2">·</span>
              Network: <span className="text-primary uppercase">{SOLANA_CONFIG.network}</span>
            </p>
          </div>

          {/* ── Wallet connect ── */}
          {!connected && (
            <div className="border border-yellow-600/40 bg-yellow-600/5 p-4 space-y-3">
              <div className="text-xs text-yellow-500 font-mono uppercase tracking-widest">
                Wallet not connected
              </div>
              <WalletMultiButton />
            </div>
          )}

          {/* ── Factory not initialized ── */}
          {connected && factoryLoaded && !factory && (
            <div className="border border-yellow-600/40 bg-yellow-600/5 p-4 space-y-3">
              <div className="flex items-center gap-2 text-yellow-500">
                <AlertTriangle size={16} />
                <span className="text-xs font-mono uppercase tracking-widest">Factory not initialized</span>
              </div>
              <p className="text-xs text-gray-400 font-mono">
                The HyperFun factory has not been initialized on this network yet. The first signer becomes the factory authority and treasury.
              </p>
              <button
                onClick={onInitFactory}
                disabled={submitting}
                className="w-full py-3 bg-primary text-black font-bold uppercase text-xs tracking-widest hover:bg-primary/80 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                Initialize Factory
              </button>
            </div>
          )}

          {/* ── Factory loaded — show summary + form ── */}
          {connected && factory && (
            <>
              <div className="border border-primary/20 bg-primary/5 p-4 text-xs font-mono space-y-1">
                <div className="text-gray-500 uppercase tracking-widest mb-2">Factory</div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Total vaults:</span>
                  <span className="text-white">{factory.vaultCount.toString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Creation fee:</span>
                  <span className="text-white">
                    {Number(factory.creationFee) / 1_000_000} USDC
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Status:</span>
                  <span className={factory.paused ? 'text-red-500' : 'text-green-500'}>
                    {factory.paused ? 'PAUSED' : 'ACTIVE'}
                  </span>
                </div>
              </div>

              {/* ── Form ── */}
              <div className="border border-primary/20 bg-primary/5 p-6 space-y-4">
                <Field
                  label="Vault Name"
                  value={name}
                  onChange={setName}
                  placeholder="Alpha Momentum Fund"
                  maxLength={64}
                />
                <Field
                  label="Token Symbol"
                  value={symbol}
                  onChange={(v) => setSymbol(v.toUpperCase())}
                  placeholder="ALPHA"
                  maxLength={16}
                />
                <Field
                  label="Performance Fee (%)"
                  value={feePct}
                  onChange={setFeePct}
                  placeholder="20"
                  type="number"
                />

                {/* Description (Optional) */}
                <div className="space-y-1">
                  <label className="block text-[10px] text-gray-500 uppercase tracking-widest font-mono">
                    Description <span className="text-gray-600">(Optional)</span>
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={MAX_DESCRIPTION}
                    rows={3}
                    placeholder="What does this vault trade?"
                    className="w-full bg-black border border-primary/20 px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-primary transition-colors resize-none"
                  />
                  <div className="text-right text-[10px] text-gray-600 font-mono">
                    {description.length}/{MAX_DESCRIPTION}
                  </div>
                </div>

                {/* Vault Image */}
                <div className="space-y-1">
                  <label className="block text-[10px] text-gray-500 uppercase tracking-widest font-mono">
                    Vault Image
                  </label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPTED_IMAGE_TYPES.join(',')}
                    onChange={(e) => onPickImage(e.target.files?.[0] ?? null)}
                    className="hidden"
                  />
                  {imagePreview ? (
                    <div className="flex items-center gap-3 border border-primary/20 bg-black p-2">
                      <img src={imagePreview} alt="preview" className="w-16 h-16 object-cover border border-border" />
                      <div className="flex-1 min-w-0 text-[11px] font-mono">
                        <div className="text-white truncate">{imageFile?.name}</div>
                        <div className="text-gray-500">
                          {imageFile ? `${(imageFile.size / 1024).toFixed(1)} KB` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={clearImage}
                        className="text-gray-400 hover:text-red-500 p-1"
                        aria-label="Remove image"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full border border-dashed border-primary/30 hover:border-primary bg-black px-3 py-4 text-xs text-gray-400 font-mono uppercase tracking-widest flex items-center justify-center gap-2 transition-colors"
                    >
                      <ImagePlus size={14} /> Upload image (PNG / JPG / WEBP, ≤5MB)
                    </button>
                  )}
                </div>

                {/* Social Links (Optional) */}
                <div className="space-y-2">
                  <label className="block text-[10px] text-gray-500 uppercase tracking-widest font-mono">
                    Social Links <span className="text-gray-600">(Optional)</span>
                  </label>
                  <SocialField icon={<Globe size={12} />}        value={website}  onChange={setWebsite}  placeholder="https://example.com" />
                  <SocialField icon={<span className="text-[10px] font-bold">𝕏</span>} value={twitter} onChange={setTwitter} placeholder="https://x.com/handle" />
                  <SocialField icon={<Send size={12} />}         value={telegram} onChange={setTelegram} placeholder="https://t.me/group" />
                </div>

                {uploadStage && (
                  <div className="flex items-center gap-2 text-[11px] text-primary font-mono">
                    <Loader2 size={12} className="animate-spin" /> {uploadStage}
                  </div>
                )}

                <button
                  onClick={onCreate}
                  disabled={submitting || factory.paused}
                  className="w-full py-3 bg-primary text-black font-bold uppercase text-xs tracking-widest hover:bg-primary/80 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
                >
                  {submitting && <Loader2 size={14} className="animate-spin" />}
                  {submitting ? (uploadStage ?? 'Creating…') : 'Create Vault'}
                </button>
              </div>
            </>
          )}

          {/* ── Error ── */}
          {errMsg && (
            <div className="border border-red-600/40 bg-red-600/5 p-3 text-xs text-red-500 font-mono break-all">
              ❌ {errMsg}
            </div>
          )}

          {/* ── Success ── */}
          {result && (
            <div className="border border-green-600/40 bg-green-600/5 p-4 space-y-2 text-xs font-mono">
              <div className="text-green-500 uppercase tracking-widest font-bold">🎉 Vault Created!</div>
              <Row label="Vault PDA"   value={result.vaultPda}   link={`${EXPLORER_BASE}/address/${result.vaultPda}${cluster}`} />
              <Row label="Vault Mint"  value={result.vaultMint}  link={`${EXPLORER_BASE}/address/${result.vaultMint}${cluster}`} />
              <Row label="USDC ATA"    value={result.usdcVault}  link={`${EXPLORER_BASE}/address/${result.usdcVault}${cluster}`} />
              <Row label="Tx 1 create_vault"     value={result.sig1} link={`${EXPLORER_BASE}/tx/${result.sig1}${cluster}`} />
              <Row label="Tx 2 init_vault_assets" value={result.sig2} link={`${EXPLORER_BASE}/tx/${result.sig2}${cluster}`} />
              {result.metadataUri && (
                <Row
                  label="Metadata URI"
                  value={result.metadataUri}
                  link={`https://cyan-defeated-lemming-99.mypinata.cloud/ipfs/${result.metadataUri.replace('ipfs://', '')}`}
                />
              )}
              {result.sig3 && (
                <Row label="Tx 3 set_metadata_uri" value={result.sig3} link={`${EXPLORER_BASE}/tx/${result.sig3}${cluster}`} />
              )}
              {result.metadataTxError && (
                <div className="border-t border-yellow-600/40 mt-2 pt-2 space-y-1">
                  <div className="text-yellow-500 uppercase tracking-widest text-[10px] font-bold">
                    ⚠ Metadata write skipped
                  </div>
                  <div className="text-yellow-300/80 text-[10px] break-all whitespace-pre-wrap">
                    {result.metadataTxError}
                  </div>
                  <div className="text-gray-500 text-[10px] leading-relaxed">
                    Vault is live on-chain. The IPFS metadata URI exists but isn't linked
                    to the vault. If the program uses a different instruction name than{' '}
                    <code className="text-yellow-400">set_metadata_uri</code>, update{' '}
                    <code className="text-yellow-400">buildSetMetadataUriIx</code> in{' '}
                    <code className="text-yellow-400">lib/contracts/program.ts</code>.
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-2 text-xs font-bold text-gray-400 hover:text-primary uppercase tracking-widest transition-colors"
          >
            <ArrowLeft size={14} /> Back
          </button>
        </div>
      </main>
      <Footer />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Field({
  label, value, onChange, placeholder, maxLength, type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-[10px] text-gray-500 uppercase tracking-widest font-mono">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        className="w-full bg-black border border-primary/20 px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-primary transition-colors"
      />
    </div>
  );
}

function SocialField({
  icon, value, onChange, placeholder,
}: {
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center bg-black border border-primary/20 focus-within:border-primary transition-colors">
      <span className="px-3 text-gray-500 flex items-center justify-center">{icon}</span>
      <input
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent py-2 pr-3 text-sm text-white font-mono focus:outline-none"
      />
    </div>
  );
}

function Row({ label, value, link }: { label: string; value: string; link: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-gray-500 uppercase tracking-widest text-[10px]">{label}</span>
      <a
        href={link}
        target="_blank"
        rel="noreferrer"
        className="text-primary hover:underline break-all flex items-center gap-1 text-right"
      >
        {value.slice(0, 8)}…{value.slice(-6)}
        <ExternalLink size={10} />
      </a>
    </div>
  );
}
