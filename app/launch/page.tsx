'use client';

import { useEffect, useRef, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import Link from 'next/link';
import { ArrowLeft, ImagePlus, Globe, Send, X, Loader2 } from 'lucide-react';
import * as anchor from '@coral-xyz/anchor';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { MAX_PERFORMANCE_FEE_BPS, PROGRAM_ID, USDC_MINT } from '@/lib/contracts/config';
import { getProgram, getVaultPda, getUsdcVaultPda } from '@/lib/contracts/margin';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DESCRIPTION = 280;
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

async function uploadFileToIpfs(file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/pinata/upload', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Image upload failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  if (!json.ipfsUrl) throw new Error('Image upload returned no ipfsUrl');
  return json.ipfsUrl as string;
}

async function uploadJsonToIpfs(obj: unknown): Promise<string> {
  const fd = new FormData();
  fd.append('metadata', JSON.stringify(obj));
  const res = await fetch('/api/pinata/upload', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Metadata upload failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  if (!json.ipfsUrl) throw new Error('Metadata upload returned no ipfsUrl');
  return json.ipfsUrl as string;
}

export default function LaunchPage() {
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [performanceFee, setPerformanceFee] = useState('10');
  const [description, setDescription] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [website, setWebsite] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [uploadStage, setUploadStage] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [createdVaultPda, setCreatedVaultPda] = useState<string | null>(null);

  useEffect(() => {
    if (!imageFile) { setImagePreview(null); return; }
    const url = URL.createObjectURL(imageFile);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  const onPickImage = (f: File | null) => {
    setStatus(null);
    if (!f) { setImageFile(null); return; }
    if (!ACCEPTED_IMAGE_TYPES.includes(f.type)) {
      setStatus('Error: Image must be PNG, JPG, WEBP, or GIF.');
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      setStatus('Error: Image must be ≤ 5 MB.');
      return;
    }
    setImageFile(f);
  };

  const clearImage = () => {
    setImageFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCreate = async () => {
    if (!publicKey || !signTransaction || !signAllTransactions) return;
    if (!name || !symbol) {
      setStatus('Error: Name and symbol are required');
      return;
    }
    if (symbol.length > 8) {
      setStatus('Error: Symbol must be 8 characters or less');
      return;
    }
    if (!imageFile) {
      setStatus('Error: Vault image is required');
      return;
    }
    if (description.length > MAX_DESCRIPTION) {
      setStatus(`Error: Description must be ≤ ${MAX_DESCRIPTION} characters`);
      return;
    }
    const feeBps = Math.floor(parseFloat(performanceFee) * 100);
    if (isNaN(feeBps) || feeBps < 0 || feeBps > MAX_PERFORMANCE_FEE_BPS) {
      setStatus('Error: Performance fee must be 0–30%');
      return;
    }

    setIsLoading(true);
    setCreatedVaultPda(null);

    try {
      // ── Upload image + metadata to IPFS ──
      setUploadStage('Uploading image to IPFS…');
      const imageIpfsUrl = await uploadFileToIpfs(imageFile);

      const links: Record<string, string> = {};
      if (website.trim())  links.website  = website.trim();
      if (twitter.trim())  links.twitter  = twitter.trim();
      if (telegram.trim()) links.telegram = telegram.trim();

      setUploadStage('Uploading metadata to IPFS…');
      const metaJson = {
        name:        name.trim(),
        symbol:      symbol.trim().toUpperCase(),
        description: description.trim(),
        image:       imageIpfsUrl,
        links,
      };
      const metadataUri = await uploadJsonToIpfs(metaJson);

      if (metadataUri.length > 200) {
        setUploadStage(null);
        setStatus(`Error: metadataUri is ${metadataUri.length} chars (max 200)`);
        setIsLoading(false);
        return;
      }

      setUploadStage(null);
      setStatus('Generating token mint keypair...');

      const tokenMintKeypair = Keypair.generate();
      const tokenMint = tokenMintKeypair.publicKey;

      const [vaultPda] = getVaultPda(tokenMint);
      const [usdcVaultPda] = getUsdcVaultPda(vaultPda);
      const [factoryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('factory')],
        new PublicKey(PROGRAM_ID)
      );

      setStatus('Building transaction...');

      const provider = new anchor.AnchorProvider(
        connection,
        { publicKey, signTransaction, signAllTransactions },
        { commitment: 'confirmed' }
      );
      const program = getProgram(provider);

      setStatus('Awaiting wallet approval...');

      const tx = await program.methods
        .createVault(name.trim(), symbol.trim().toUpperCase(), metadataUri, new anchor.BN(feeBps))
        .accountsStrict({
          vault: vaultPda,
          tokenMint,
          usdcVault: usdcVaultPda,
          usdcMint: new PublicKey(USDC_MINT),
          factory: factoryPda,
          leader: publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([tokenMintKeypair])
        .rpc({ commitment: 'confirmed' });

      setCreatedVaultPda(vaultPda.toBase58());
      setStatus(`✅ Vault created! TX: ${tx.slice(0, 20)}...`);
    } catch (e: unknown) {
      const err = e as { message?: string; logs?: string[] };
      const logs = err.logs ?? [];
      const hint = logs.filter(l => l.includes('Error')).slice(-1).join('');
      setStatus(`Error: ${err.message?.slice(0, 150) ?? 'Transaction failed'}${hint ? ' — ' + hint : ''}`);
      setUploadStage(null);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Header
        searchQuery=""
        onSearchChange={() => {}}
        onLogoClick={() => (window.location.href = '/')}
      />

      <main className="flex-1 flex flex-col">
        {/* Sub-header */}
        <div className="border-b border-border px-4 py-3 flex items-center">
          <Link href="/" className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors">
            <ArrowLeft size={16} />
            <span className="text-sm font-bold uppercase tracking-widest">Back</span>
          </Link>
        </div>

        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <h1 className="text-xl font-black uppercase tracking-widest mb-6">
              Launch Vault
            </h1>

            <div className="space-y-4">
              {/* Vault Name */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">
                  Vault Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value.slice(0, 32))}
                  placeholder="My Alpha Fund"
                  className="w-full bg-white/5 border border-border px-3 py-2 text-sm outline-none focus:border-primary transition-colors"
                />
              </div>

              {/* Symbol */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">
                  Symbol (max 8 chars)
                </label>
                <input
                  type="text"
                  value={symbol}
                  onChange={e => setSymbol(e.target.value.toUpperCase().slice(0, 8))}
                  placeholder="ALPHA"
                  className="w-full bg-white/5 border border-border px-3 py-2 text-sm outline-none focus:border-primary transition-colors"
                />
              </div>

              {/* Performance Fee */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">
                  Performance Fee (%) <span className="text-gray-600 normal-case">Max: 30%</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={performanceFee}
                    onChange={e => setPerformanceFee(e.target.value)}
                    min="0"
                    max="30"
                    step="0.5"
                    className="w-full bg-white/5 border border-border px-3 py-2 text-sm outline-none focus:border-primary transition-colors"
                  />
                  <span className="text-sm text-gray-400">%</span>
                </div>
              </div>

              {/* Description (Optional) */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">
                  Description <span className="text-gray-600 normal-case">(Optional)</span>
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  maxLength={MAX_DESCRIPTION}
                  rows={3}
                  placeholder="What does this vault trade?"
                  className="w-full bg-white/5 border border-border px-3 py-2 text-sm outline-none focus:border-primary transition-colors resize-none"
                />
                <div className="text-right text-[10px] text-gray-600 mt-0.5">
                  {description.length}/{MAX_DESCRIPTION}
                </div>
              </div>

              {/* Vault Image (required) */}
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">
                  Vault Image <span className="text-red-400">*</span>
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_IMAGE_TYPES.join(',')}
                  onChange={e => onPickImage(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
                {imagePreview ? (
                  <div className="flex items-center gap-3 border border-border bg-black/40 p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imagePreview} alt="preview" className="w-16 h-16 object-cover border border-border" />
                    <div className="flex-1 min-w-0 text-[11px]">
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
                    className="w-full border border-dashed border-primary/30 hover:border-primary bg-black/40 px-3 py-4 text-xs text-gray-400 uppercase tracking-widest flex items-center justify-center gap-2 transition-colors"
                  >
                    <ImagePlus size={14} /> Upload image (PNG / JPG / WEBP, ≤5MB)
                  </button>
                )}
              </div>

              {/* Social Links (Optional) */}
              <div className="space-y-2">
                <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500">
                  Social Links <span className="text-gray-600 normal-case">(Optional)</span>
                </label>
                <SocialField icon={<Globe size={12} />} value={website} onChange={setWebsite} placeholder="https://example.com" />
                <SocialField icon={<span className="text-[10px] font-bold">𝕏</span>} value={twitter} onChange={setTwitter} placeholder="https://x.com/handle" />
                <SocialField icon={<Send size={12} />} value={telegram} onChange={setTelegram} placeholder="https://t.me/group" />
              </div>

              {/* Exit Fee Info */}
              <div className="border border-border p-3 text-xs text-gray-500 space-y-1">
                <p className="font-bold text-gray-400 uppercase tracking-widest text-[10px] mb-2">Exit Fee Tiers</p>
                <div className="flex justify-between"><span>&lt; 3 days</span><span className="text-red-400">15%</span></div>
                <div className="flex justify-between"><span>3–7 days</span><span className="text-yellow-400">8%</span></div>
                <div className="flex justify-between"><span>7–30 days</span><span className="text-yellow-400">3%</span></div>
                <div className="flex justify-between"><span>&gt; 30 days</span><span className="text-green-400">0%</span></div>
              </div>

              {/* Upload progress */}
              {uploadStage && (
                <div className="flex items-center gap-2 text-[11px] text-primary">
                  <Loader2 size={12} className="animate-spin" /> {uploadStage}
                </div>
              )}

              {/* Status */}
              {status && (
                <div className={`text-xs px-3 py-2 border ${
                  status.startsWith('Error')
                    ? 'border-red-500/30 text-red-400 bg-red-500/10'
                    : 'border-primary/30 text-primary bg-primary/10'
                }`}>
                  {status}
                </div>
              )}

              {/* View Vault link after creation */}
              {createdVaultPda && (
                <Link
                  href={`/vault/${createdVaultPda}`}
                  className="block w-full py-3 text-center font-black uppercase tracking-widest text-sm border border-primary text-primary hover:bg-primary hover:text-black transition-all"
                >
                  View Vault →
                </Link>
              )}

              {/* Submit */}
              {!publicKey ? (
                <WalletMultiButton className="w-full" />
              ) : (
                <button
                  onClick={handleCreate}
                  disabled={isLoading || !name || !symbol || !imageFile}
                  className="w-full py-3 font-black uppercase tracking-widest text-sm bg-primary text-black hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isLoading && <Loader2 size={14} className="animate-spin" />}
                  {isLoading ? (uploadStage ?? 'Creating...') : 'Create Vault'}
                </button>
              )}
            </div>
          </div>
        </div>
      </main>

      <Footer />
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
    <div className="flex items-center bg-white/5 border border-border focus-within:border-primary transition-colors">
      <span className="px-3 text-gray-500 flex items-center justify-center">{icon}</span>
      <input
        type="url"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent py-2 pr-3 text-sm text-white outline-none"
      />
    </div>
  );
}
