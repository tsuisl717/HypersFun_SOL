'use client';

/**
 * AdminPanel — leader / admin / factory-owner controls.
 *
 * Solana shell. Mirrors HyperVapor's three-tab structure (Leader / Admin /
 * Factory Owner) but every contract call is a no-op stub flagged with
 * `// TODO(solana)` for the consumer to wire to the Anchor program.
 *
 * Sections kept (have a Solana analog):
 *   • Leader — token metadata (image / description / external URL)
 *   • Leader — direct metadata URI override
 *   • Admin  — pause / unpause vault
 *   • Admin  — reset bonding curve
 *   • Factory Owner — set treasury / set fee / global pause (stubs)
 *
 * Sections dropped (Hyperliquid-only):
 *   • L1 Spot → EVM withdraw, Emergency EVM withdraw, Builder DEX, etc.
 */

import { useCallback, useState } from 'react';
import { Upload, X } from 'lucide-react';
import type { VaultInfo, BondingCurveInfo, ReserveStatus } from './types';

type AdminTab = 'leader' | 'admin' | 'factory';

export interface AdminPanelProps {
  vaultAddress: string;
  vaultInfo: VaultInfo | null;
  bcInfo: BondingCurveInfo | null;
  reserveStatus: ReserveStatus | null;
  loading: boolean;
  status: string;
  setLoading: (loading: boolean) => void;
  setStatus: (status: string) => void;
  loadVaultInfo: () => Promise<void> | void;
  isLeader?: boolean;
  isAdmin?: boolean;
  isFactoryOwner?: boolean;
  /** TODO(solana): pass an Anchor program / connection so handlers can call .rpc() */
}

export default function AdminPanel({
  vaultAddress: _vaultAddress,
  vaultInfo,
  bcInfo: _bcInfo,
  reserveStatus,
  loading,
  status,
  setLoading,
  setStatus,
  loadVaultInfo,
  isLeader = false,
  isAdmin = false,
  isFactoryOwner = false,
}: AdminPanelProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('leader');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>(vaultInfo?.imageUrl || '');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(true);

  // ─── Image handling ──────────────────────────────────────────────────
  const handleImageSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        setStatus('Error: Please select an image file');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setStatus('Error: Image must be less than 5MB');
        return;
      }
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => setImagePreview(reader.result as string);
      reader.readAsDataURL(file);
    },
    [setStatus],
  );

  const removeImage = useCallback(() => {
    setImageFile(null);
    setImagePreview(vaultInfo?.imageUrl || '');
  }, [vaultInfo?.imageUrl]);

  // ─── IPFS upload (uses existing /api/pinata/upload route) ──────────
  const uploadToIPFS = useCallback(async (file: File): Promise<string> => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch('/api/pinata/upload', {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (errorData.error === 'Pinata not configured') {
        // Fallback to data: URI
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }
      throw new Error(errorData.error || 'Upload failed');
    }
    const data = await response.json();
    return data.ipfsUrl ?? data.url;
  }, []);

  // ─── Stub action handlers ────────────────────────────────────────────
  // TODO(solana): replace each with an Anchor `program.methods.*().rpc()` call.

  const handleSaveMetadata = useCallback(async () => {
    setLoading(true);
    setUploadingImage(true);
    setStatus('Uploading metadata…');
    try {
      const descEl = document.getElementById('metadataDescription') as HTMLTextAreaElement;
      const urlEl = document.getElementById('metadataExternalUrl') as HTMLInputElement;

      let imageUrl = imagePreview;
      if (imageFile) imageUrl = await uploadToIPFS(imageFile);

      const metadata: Record<string, unknown> = {
        name: vaultInfo?.name ?? 'Vault Token',
        symbol: vaultInfo?.symbol ?? 'VT',
      };
      if (imageUrl) metadata.image = imageUrl;
      if (descEl?.value) metadata.description = descEl.value;
      if (urlEl?.value) metadata.external_url = urlEl.value;

      // TODO(solana): build Anchor instruction to set vault metadataURI
      // Example sketch:
      //   const metadataJSON = JSON.stringify(metadata);
      //   const metadataURI = 'data:application/json;base64,' +
      //     btoa(unescape(encodeURIComponent(metadataJSON)));
      //   await program.methods.setMetadataUri(metadataURI)
      //     .accounts({ vault: vaultPda, leader: publicKey })
      //     .rpc();

      console.log('[AdminPanel] would set metadata:', metadata);
      setStatus('TODO: wire setMetadataUri to Anchor program');
      await loadVaultInfo();
      setImageFile(null);
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setLoading(false);
      setUploadingImage(false);
    }
  }, [imageFile, imagePreview, uploadToIPFS, vaultInfo, setLoading, setStatus, loadVaultInfo]);

  const handleSetDirectUri = useCallback(async () => {
    const el = document.getElementById('metadataDirectURI') as HTMLInputElement;
    if (!el?.value) {
      setStatus('Error: Please enter URI');
      return;
    }
    setLoading(true);
    setStatus('Setting metadata URI…');
    try {
      // TODO(solana): program.methods.setMetadataUri(el.value).rpc()
      console.log('[AdminPanel] would set URI:', el.value);
      setStatus('TODO: wire setMetadataUri to Anchor program');
      await loadVaultInfo();
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setLoading(false);
    }
  }, [setLoading, setStatus, loadVaultInfo]);

  const handleSetPaused = useCallback(
    async (paused: boolean) => {
      setLoading(true);
      setStatus(paused ? 'Pausing…' : 'Unpausing…');
      try {
        // TODO(solana): program.methods.setPaused(paused).rpc()
        console.log('[AdminPanel] would setPaused:', paused);
        setStatus('TODO: wire setPaused to Anchor program');
        await loadVaultInfo();
      } catch (e) {
        setStatus(`Error: ${e instanceof Error ? e.message : 'unknown'}`);
      } finally {
        setLoading(false);
      }
    },
    [setLoading, setStatus, loadVaultInfo],
  );

  const handleResetBc = useCallback(async () => {
    setLoading(true);
    setStatus('Resetting bonding curve…');
    try {
      // TODO(solana): program.methods.resetBc().rpc()
      console.log('[AdminPanel] would reset BC');
      setStatus('TODO: wire resetBc to Anchor program');
      await loadVaultInfo();
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setLoading(false);
    }
  }, [setLoading, setStatus, loadVaultInfo]);

  // ─── Tab definitions ─────────────────────────────────────────────────
  const allTabs: { id: AdminTab; label: string; activeClass: string; visible: boolean }[] = [
    { id: 'leader',  label: 'Leader',        activeClass: 'bg-green-600 text-white',  visible: isLeader || true },
    { id: 'admin',   label: 'Admin',         activeClass: 'bg-blue-600 text-white',   visible: isAdmin || isLeader },
    { id: 'factory', label: 'Factory Owner', activeClass: 'bg-purple-600 text-white', visible: isFactoryOwner },
  ];
  const tabs = allTabs.filter((t) => t.visible);

  const totalAssets = reserveStatus
    ? parseFloat(reserveStatus.totalAssets || '0')
    : 0;

  return (
    <div className="h-full bg-card flex flex-col overflow-auto">
      {/* Mobile collapsible header */}
      <div className="md:hidden">
        <button
          onClick={() => setMobileExpanded((v) => !v)}
          className="w-full flex items-center justify-between p-2 border-b border-border bg-white/5"
        >
          <span className="text-xs font-black uppercase tracking-widest text-gray-300">
            Admin Controls
          </span>
          <span className="text-[10px] text-gray-500">
            {mobileExpanded ? '▲' : '▼'}
          </span>
        </button>
      </div>

      {/* Desktop tab navigation */}
      <div className="hidden md:flex gap-1 p-2 border-b border-border bg-white/5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs font-black uppercase tracking-widest transition-all ${
              activeTab === tab.id ? tab.activeClass : 'text-gray-500 hover:text-white bg-white/5'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className={`p-2 md:p-4 space-y-2 md:space-y-3 ${!mobileExpanded ? 'hidden md:block' : ''}`}>
        {/* Reserve summary */}
        <div className="grid grid-cols-3 gap-1 md:gap-2">
          <Stat label="USDC Reserve" value={`$${parseFloat(reserveStatus?.usdcReserve ?? '0').toFixed(2)}`} accent="text-primary" />
          <Stat label="External"     value={`$${parseFloat(reserveStatus?.externalAssets ?? '0').toFixed(2)}`} accent="text-amber-300" />
          <Stat label="Total"        value={`$${totalAssets.toFixed(2)}`} accent="text-cyan-400" />
        </div>

        {/* Mobile tab selector */}
        <div className="flex md:hidden gap-0.5 bg-white/5 p-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-1 text-[9px] font-black uppercase transition-all ${
                activeTab === tab.id ? tab.activeClass : 'text-gray-500'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ──────────────── LEADER TAB ──────────────── */}
        {activeTab === 'leader' && (
          <div className="space-y-2 md:space-y-3">
            <div>
              <div className="text-[10px] md:text-xs text-green-400 mb-2 uppercase tracking-widest font-bold">
                Token Metadata
              </div>

              {/* Image upload */}
              <div className="mb-2 md:mb-3">
                <div className="text-[9px] md:text-xs text-gray-500 mb-1">Image</div>
                {!imagePreview ? (
                  <label className="flex flex-col items-center justify-center w-full h-16 md:h-24 border border-dashed border-border rounded-sm cursor-pointer hover:border-green-400 transition bg-white/5">
                    <Upload className="w-4 h-4 md:w-6 md:h-6 text-gray-500 mb-1" />
                    <p className="text-[9px] md:text-xs text-gray-500">
                      Click to upload (PNG, JPG up to 5MB)
                    </p>
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*"
                      onChange={handleImageSelect}
                    />
                  </label>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="relative w-14 h-14 md:w-20 md:h-20 shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imagePreview}
                        alt="Preview"
                        className="w-full h-full object-cover rounded-sm border border-border"
                      />
                      <button
                        onClick={removeImage}
                        className="absolute -top-1 -right-1 w-4 h-4 md:w-5 md:h-5 bg-red-600 rounded-full flex items-center justify-center hover:bg-red-500 transition"
                      >
                        <X className="w-2.5 h-2.5 md:w-3 md:h-3" />
                      </button>
                    </div>
                    <label className="flex-1 flex flex-col items-center justify-center h-14 md:h-20 border border-dashed border-border rounded-sm cursor-pointer hover:border-green-400 transition bg-white/5">
                      <Upload className="w-3 h-3 md:w-4 md:h-4 text-gray-500 mb-0.5" />
                      <p className="text-[9px] md:text-xs text-gray-500">Change</p>
                      <input
                        type="file"
                        className="hidden"
                        accept="image/*"
                        onChange={handleImageSelect}
                      />
                    </label>
                  </div>
                )}
                {imageFile && (
                  <p className="text-[9px] md:text-xs text-green-400 mt-1 truncate">
                    New: {imageFile.name}
                  </p>
                )}
              </div>

              {/* Description */}
              <div className="mb-2">
                <div className="text-[9px] md:text-xs text-gray-500 mb-1">Description</div>
                <textarea
                  id="metadataDescription"
                  placeholder="Token description..."
                  defaultValue={vaultInfo?.description || ''}
                  rows={2}
                  className="w-full bg-black border border-border/50 px-2 py-1.5 text-[10px] md:text-sm resize-none focus:border-green-400 focus:outline-none"
                />
              </div>

              {/* External URL */}
              <div className="mb-2">
                <div className="text-[9px] md:text-xs text-gray-500 mb-1">External URL</div>
                <input
                  type="text"
                  id="metadataExternalUrl"
                  placeholder="https://yoursite.com (optional)"
                  className="w-full bg-black border border-border/50 px-2 py-1.5 text-[10px] md:text-sm font-mono focus:border-green-400 focus:outline-none"
                />
              </div>

              {/* Save button */}
              <button
                onClick={handleSaveMetadata}
                disabled={loading || uploadingImage}
                className="w-full bg-green-600 hover:bg-green-500 disabled:bg-white/5 disabled:text-gray-500 px-4 py-1.5 text-[10px] md:text-xs font-black uppercase tracking-widest transition-all"
              >
                {uploadingImage ? 'Uploading...' : loading ? '...' : 'Save Metadata'}
              </button>
            </div>

            {/* Direct URI */}
            <details className="bg-white/5 p-2">
              <summary className="text-[9px] md:text-xs text-gray-500 cursor-pointer hover:text-gray-400 uppercase tracking-widest">
                Advanced: Direct URI
              </summary>
              <div className="flex gap-1 md:gap-2 mt-2">
                <input
                  type="text"
                  id="metadataDirectURI"
                  placeholder="ipfs://... or data:..."
                  className="flex-1 bg-black border border-border/50 px-2 py-1.5 text-[10px] md:text-sm font-mono focus:border-green-400 focus:outline-none"
                />
                <button
                  onClick={handleSetDirectUri}
                  disabled={loading}
                  className="bg-green-600 hover:bg-green-500 disabled:bg-white/5 disabled:text-gray-500 px-3 py-1.5 text-[10px] md:text-xs font-black uppercase"
                >
                  Set
                </button>
              </div>
            </details>
          </div>
        )}

        {/* ──────────────── ADMIN TAB ──────────────── */}
        {activeTab === 'admin' && (
          <div className="space-y-2 md:space-y-3">
            {/* Pause / Unpause */}
            <Section title="Vault Pause" accent="text-blue-400">
              <p className="text-[10px] text-gray-500 mb-2">
                When paused, all buy / sell instructions revert.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => handleSetPaused(true)}
                  disabled={loading || vaultInfo?.symbol === undefined}
                  className="py-2 bg-rose-500/20 border border-rose-500/40 text-rose-300 hover:bg-rose-500/30 disabled:opacity-40 text-xs font-bold uppercase tracking-widest"
                >
                  Pause
                </button>
                <button
                  onClick={() => handleSetPaused(false)}
                  disabled={loading}
                  className="py-2 bg-lime-500/20 border border-lime-500/40 text-lime-300 hover:bg-lime-500/30 disabled:opacity-40 text-xs font-bold uppercase tracking-widest"
                >
                  Unpause
                </button>
              </div>
            </Section>

            {/* Reset Bonding Curve */}
            <Section title="Reset Bonding Curve" accent="text-blue-400">
              <p className="text-[10px] text-gray-500 mb-2">
                Recompute virtual reserves from the current NAV / total assets. Use sparingly.
              </p>
              <button
                onClick={handleResetBc}
                disabled={loading}
                className="w-full py-2 bg-blue-500/20 border border-blue-500/40 text-blue-300 hover:bg-blue-500/30 disabled:opacity-40 text-xs font-bold uppercase tracking-widest"
              >
                {loading ? '...' : 'Reset BC'}
              </button>
            </Section>

            {/* Drift integration placeholder — wire MarginTradingPanel here if desired */}
            <Section title="Drift Integration" accent="text-blue-400">
              <p className="text-[10px] text-gray-500">
                Margin trading via Drift CPI is exposed in the leader-only{' '}
                <code className="text-blue-300">MarginTradingPanel</code> component.
              </p>
            </Section>
          </div>
        )}

        {/* ──────────────── FACTORY OWNER TAB ──────────────── */}
        {activeTab === 'factory' && (
          <div className="space-y-2 md:space-y-3">
            <Section title="Set Treasury" accent="text-purple-400">
              <p className="text-[10px] text-gray-500 mb-2">
                Address that receives protocol fees.
              </p>
              <div className="flex gap-2">
                <input
                  id="factoryTreasury"
                  placeholder="base58 pubkey"
                  className="flex-1 bg-black border border-border/50 px-2 py-1.5 text-[10px] md:text-sm font-mono focus:border-purple-400 focus:outline-none"
                />
                <button
                  onClick={() => {
                    setStatus('TODO(solana): wire setTreasury to Anchor program');
                  }}
                  disabled={loading}
                  className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 px-3 py-1.5 text-[10px] md:text-xs font-black uppercase"
                >
                  Set
                </button>
              </div>
            </Section>

            <Section title="Set Trading Fee" accent="text-purple-400">
              <div className="flex gap-2 items-center">
                <input
                  id="factoryFeeBps"
                  type="number"
                  placeholder="100 = 1%"
                  className="flex-1 bg-black border border-border/50 px-2 py-1.5 text-[10px] md:text-sm font-mono focus:border-purple-400 focus:outline-none"
                />
                <span className="text-[10px] text-gray-500">bps</span>
                <button
                  onClick={() => {
                    setStatus('TODO(solana): wire setTradingFee to Anchor program');
                  }}
                  disabled={loading}
                  className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 px-3 py-1.5 text-[10px] md:text-xs font-black uppercase"
                >
                  Set
                </button>
              </div>
            </Section>

            <Section title="Global Pause" accent="text-purple-400">
              <p className="text-[10px] text-gray-500 mb-2">
                Pauses every vault under this factory.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => {
                    setStatus('TODO(solana): wire factory pause');
                  }}
                  className="py-2 bg-rose-500/20 border border-rose-500/40 text-rose-300 hover:bg-rose-500/30 text-xs font-bold uppercase tracking-widest"
                >
                  Pause All
                </button>
                <button
                  onClick={() => {
                    setStatus('TODO(solana): wire factory unpause');
                  }}
                  className="py-2 bg-lime-500/20 border border-lime-500/40 text-lime-300 hover:bg-lime-500/30 text-xs font-bold uppercase tracking-widest"
                >
                  Unpause All
                </button>
              </div>
            </Section>
          </div>
        )}

        {/* Status banner */}
        {status && (
          <div
            className={`px-2 py-1.5 text-[11px] font-mono border ${
              status.toLowerCase().includes('error') || status.toLowerCase().includes('fail')
                ? 'border-red-500/40 bg-red-500/5 text-red-400'
                : status.toLowerCase().includes('todo')
                ? 'border-yellow-500/40 bg-yellow-500/5 text-yellow-400'
                : status.toLowerCase().includes('success')
                ? 'border-lime-500/40 bg-lime-500/5 text-lime-400'
                : 'border-primary/30 bg-primary/5 text-primary'
            }`}
          >
            {status}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function Stat({
  label,
  value,
  accent,
}: { label: string; value: string; accent: string }) {
  return (
    <div className="bg-white/5 p-1.5 md:p-3 text-center">
      <div className="text-[8px] md:text-xs text-gray-500 uppercase">{label}</div>
      <div className={`text-xs md:text-lg font-bold font-mono ${accent}`}>{value}</div>
    </div>
  );
}

function Section({
  title,
  accent,
  children,
}: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div>
      <div className={`text-[10px] md:text-xs mb-2 uppercase tracking-widest font-bold ${accent}`}>
        {title}
      </div>
      {children}
    </div>
  );
}
