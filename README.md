# HypersFun on Solana — Permissionless On-Chain Hedge Fund Protocol
 
> **TL;DR** — HypersFun lets anyone launch a tokenized, NAV-anchored hedge fund in one click. Investors buy SPL fund tokens via a virtual AMM; the manager actively trades perpetuals on Drift Protocol; PnL flows transparently into NAV. This Solana implementation extends our [production HyperEVM deployment](https://hypers.fun) with native Drift integration, sub-second NAV updates, and Solana-DeFi composability.
 
[Live Devnet](https://sol.hypers.fun) · [Hyperliquid Mainnet](https://hypers.fun) · [Protocol Docs](https://hyper-fun.gitbook.io/hypers.fun) · [@hypersFun](https://x.com/hypersFun)
 
---
 
## At a Glance
 
| | |
| --- | --- |
| **Category** | DeFi / Asset Management / Perpetuals |
| **Chain** | Solana (Devnet for hackathon, mainnet on roadmap) |
| **Trading Venue** | Drift Protocol (CPI integration) |
| **Underlying Asset** | USDC (devnet) |
| **Fund Token Standard** | SPL Token (Token-2022 compatible) |
| **Smart Contract Framework** | Anchor (Rust) |
| **Frontend** | Next.js 15 + React 19 + TypeScript |
| **Status** | Devnet live, fully functional end-to-end |
| **Code Size** | ~75% TypeScript, ~17% Rust, ~6% JS |
| **License** | Proprietary (open-source migration on roadmap) |
 
---
 
## 1. Problem
 
On-chain asset management has two structural failures:
 
1. **Fund creation is permissioned and slow.** Existing platforms (dHEDGE, Enzyme, Drift Vaults) require lengthy onboarding for managers, gatekeeping access for emerging traders.
2. **Investor liquidity is poor.** Most managed vaults lock deposits, impose redemption queues, or lack secondary markets. Investors cannot exit instantly when they need to.
The result: trillions in retail crypto capital remain stuck between memecoin speculation and CEX-based copy trading, with no clean on-chain alternative for accessing managed alpha.
 
## 2. Solution
 
HypersFun resolves both failures with a single architectural primitive:
 
> **A NAV-anchored virtual AMM that wraps a Drift-trading vault.**
 
This means:
 
- **Anyone** can deploy a fund in one click — no whitelisting, no minimum AUM
- **Fund tokens are SPL tokens** — fully transferable, composable with Jupiter, Tensor, and the broader Solana DeFi stack
- **The virtual AMM provides instant liquidity** — investors enter and exit at NAV-anchored prices without waiting for an LP or queue
- **The manager trades real perpetuals on Drift** — PnL accrues to vault NAV, which adjusts the virtual AMM curve in real time
## 3. Key Innovation Contributions
 
This section explicitly lists the novel contributions of this work:
 
| # | Contribution | Why It Matters |
| --- | --- | --- |
| 1 | **NAV-anchored virtual AMM** with dynamic scaling | First Solana implementation combining ETF-style NAV pricing with pump.fun-style instant liquidity. A $10K trade has identical % impact at $100K and $10M TVL. |
| 2 | **Permissionless fund factory** via Anchor PDAs | One-click deployment with deterministic addresses; no manager whitelisting, no onboarding cost. |
| 3 | **High-water-mark performance fees** on-chain | Profit fees only accrue above the fund's all-time NAV peak — eliminates double-charging on drawdown recovery. |
| 4 | **Tiered exit fees** routed back into NAV | Anti-churn mechanism (15% → 0% over 30 days) that rewards long-term LPs without locking deposits. |
| 5 | **Drift CPI integration** for active perp management | First fund framework to use Drift as its underlying execution venue via Cross-Program Invocation. |
| 6 | **Capital flow segmentation** | Liquid reserve / active capital split prevents redemption-vs-position liquidity mismatches. |
 
## 4. Architecture
 
### 4.1 System Overview
 
```
┌─────────────────────────────────────────────────────┐
│                    INVESTORS                         │
│        (Buy / Sell fund tokens via vAMM)             │
└─────────────────────┬───────────────────────────────┘
                      │ USDC / SPL Token
                      ▼
┌─────────────────────────────────────────────────────┐
│              HypersFunFactory (PDA)                  │
│   Deploys & registers all fund vaults                │
└─────────────────────┬───────────────────────────────┘
                      │ deploy
                      ▼
┌─────────────────────────────────────────────────────┐
│                Fund Vault (PDA)                      │
│  • SPL Token Mint Authority                          │
│  • Virtual AMM State (reserves, scaling factor)      │
│  • NAV Accounting (HWM, total assets)                │
│  • Manager Delegate Authority                        │
│  • Liquid Reserve (USDC buffer)                      │
└─────────────┬───────────────────────┬───────────────┘
              │                       │
       Liquid Reserve            Active Capital
       (instant redeem)          (manager trades)
                                      │
                                      ▼
                      ┌──────────────────────────────┐
                      │  Drift Protocol (CPI)        │
                      │  Perp markets: SOL, BTC, ETH │
                      └──────────────────────────────┘
```
 
### 4.2 On-Chain Account Structure
 
| Account | Type | Purpose |
| --- | --- | --- |
| `Factory` | PDA singleton | Global registry of all funds; tracks fund count and protocol parameters |
| `FundVault` | PDA per fund | Holds NAV state, fee config, manager authority, HWM, AMM reserves |
| `FundTokenMint` | SPL Mint | One per fund; mint authority is the FundVault PDA |
| `LiquidReserveATA` | Token Account | USDC buffer for instant redemptions |
| `DriftSubaccount` | Drift account | Per-fund Drift trading account, delegated to manager |
 
### 4.3 Pricing Mathematics
 
The fund token price `P` at any moment is determined by:
 
```
NAV  = (LiquidReserve_USDC + DriftEquity_USDC) / TotalSupply
P    = NAV × CurveFactor(TradeSize, VirtualReserves)
 
where:
  CurveFactor → 1.0 for small trades
  CurveFactor → reflects slippage for large trades
  VirtualReserves scale linearly with TotalSupply
```
 
This guarantees three properties:
 
1. **NAV alignment** — the long-run price equals NAV; arbitrageurs eliminate divergence
2. **Slippage scales with TVL** — a fund at $10M TVL absorbs the same $10K trade with the same % impact as a $100K fund
3. **No external LP required** — the virtual AMM is fully self-contained inside the vault PDA
### 4.4 Buy / Sell Pseudocode
 
```rust
// Buy: USDC → fund tokens
fn buy(usdc_in: u64, fund: &mut FundVault) -> u64 {
    let nav = compute_nav(fund);
    let curve_price = apply_dynamic_curve(nav, usdc_in, fund.virtual_reserves);
    let tokens_out = usdc_in * PRECISION / curve_price;
 
    fund.liquid_reserve += usdc_in * LIQUID_RATIO;       // e.g. 30%
    fund.drift_capital  += usdc_in * (1 - LIQUID_RATIO); // e.g. 70%
    mint_to_user(tokens_out);
    update_hwm_if_needed(fund);
    tokens_out
}
 
// Sell: fund tokens → USDC (with tiered exit fee)
fn sell(tokens_in: u64, fund: &mut FundVault, holder: &Holder) -> u64 {
    let nav = compute_nav(fund);
    let curve_price = apply_dynamic_curve(nav, -tokens_in, fund.virtual_reserves);
    let gross_usdc = tokens_in * curve_price / PRECISION;
 
    let exit_fee_bps = tier_lookup(now() - holder.entry_timestamp);
    let net_usdc     = gross_usdc * (BPS - exit_fee_bps) / BPS;
 
    burn_from_user(tokens_in);
    payout_from_liquid_reserve(net_usdc); // falls through to Drift unwind if needed
    accrue_exit_fee_to_nav(gross_usdc - net_usdc);
    net_usdc
}
```
 
## 5. Fee Structure
 
### 5.1 Performance Fee — High-Water Mark
 
| Parameter | Value |
| --- | --- |
| Maximum performance fee | 30% (3000 bps) |
| Calculation basis | NAV gain above prior all-time NAV peak |
| Accrual frequency | Per investor, on redemption |
| Recovery treatment | No fee on losses recovered (no double-dip) |
 
### 5.2 Exit Fee — Tiered Anti-Churn
 
| Holding Period | Exit Fee | Routed To |
| --- | --- | --- |
| < 3 days | 15% (1500 bps) | Vault NAV (rewards remaining holders) |
| 3 – 7 days | 8% (800 bps) | Vault NAV |
| 7 – 30 days | 3% (300 bps) | Vault NAV |
| > 30 days | 0% | — |
 
## 6. Competitive Analysis
 
| Feature | HypersFun (this repo) | Drift Vaults | dHEDGE | Enzyme | pump.fun |
| --- | --- | --- | --- | --- | --- |
| One-click fund launch | ✅ | ❌ (manager onboarding required) | ❌ | ❌ | ✅ |
| Fund tokens are SPL / ERC-20 | ✅ (SPL) | ✅ (optional tokenization) | ✅ | ✅ | ✅ |
| Virtual AMM secondary market | ✅ | ❌ | ❌ | ❌ | ✅ |
| NAV-anchored pricing | ✅ | ✅ | ✅ | ✅ | ❌ |
| Active perp trading | ✅ (Drift) | ✅ (Drift native) | Limited | Limited | ❌ |
| High-water-mark fees | ✅ | ✅ | ✅ | ✅ | N/A |
| Tiered exit fees | ✅ | ❌ | ❌ | ❌ | N/A |
| Multi-chain (HyperEVM + Solana) | ✅ | ❌ | ❌ | ✅ | ❌ |
| Permissionless | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Combines all of the above** | **✅** | ❌ | ❌ | ❌ | ❌ |
 
The unique positioning of HypersFun: **the only protocol that combines pump.fun-style permissionless launch + virtual AMM liquidity with hedge-fund-grade NAV accounting and active perp trading**.
 
## 7. Tech Stack
 
### 7.1 On-Chain (Rust / Anchor)
 
- **Anchor framework** for type-safe Solana program development
- **Cross-Program Invocation (CPI)** into Drift Protocol's `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`
- **Program Derived Addresses (PDAs)** for deterministic fund and authority accounts
- **SPL Token program** for fund token issuance
- **Pyth oracles** (via Drift) for real-time perp pricing
### 7.2 Frontend
 
- **Next.js 15** App Router for server components and edge-rendered routes
- **React 19** with concurrent rendering for real-time NAV updates
- **TypeScript 5** for end-to-end type safety
- **Tailwind CSS 4** for styling
- **TanStack Query** for cache and on-chain state management
- **`@solana/wallet-adapter-*`** supporting Phantom, Solflare, Ledger, Torus
### 7.3 Off-Chain Infrastructure
 
- **Pinata (IPFS)** for fund metadata and image pinning
- **`lightweight-charts`** + **recharts** for price/NAV visualization
- **Vercel** for frontend deployment
## 8. Project Layout
 
```
app/                          Next.js App Router
├── api/                      Server routes (pinata, balance, vault candles)
├── vault/[id]/               Per-vault page (chart, trade panel, stats)
├── launch/                   Fund creation flow
├── create-l1/                Layer-1 fund creation flow
├── profile/                  Wallet profile and holdings
└── faucet/                   Devnet USDC faucet
 
components/
├── bonding-curve-vault/      Vault-specific UI
│   ├── PriceChart.tsx
│   ├── MarginTradingPanel.tsx
│   └── AdvancedChart.tsx
├── Header.tsx
├── Footer.tsx
├── TokenCard.tsx
└── Hero.tsx
 
lib/
├── contracts/
│   ├── config.ts             Network config, addresses, fee constants
│   ├── idl/                  Anchor IDL types
│   └── margin.ts             Drift margin calculation helpers
├── vaults.ts                 Vault loader / list aggregation
├── vault-events.ts           On-chain event subscriptions
├── indicators.ts             TA indicators
└── hooks/                    React hooks
 
programs/                     Anchor smart contracts (Rust)
public/                       Static assets
```
 
## 9. Smart Contract Reference
 
### 9.1 Devnet Addresses ([`lib/contracts/config.ts`](lib/contracts/config.ts))
 
| Component | Address |
| --- | --- |
| HypersFun Program ID | `5jmoeSiY3kyFhaipuiV1Six4sAwMetsEWNNCTBdfrEza` |
| Factory PDA | `BifoNKMbqCWLuHpFyXABGiRC6W7Hty5RtakkUrK5USLN` |
| USDC Mint (Drift devnet) | `8FfvSRKMZRDHrCBy142XMUXrKEkXnxDQ4YmJv7xbAw8Q` |
| Drift Program ID | `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P` |
| Drift State | `HAjeZdvbUYWWsWJqEdxYVdwGc4D8XojUYW7hTsiU6crJ` |
| SOL-PERP Market | `FDejXbUrSy6zayBCL5xuk2SXLHZgr8ppfFTLcHbyJorY` |
 
### 9.2 Key Instructions
 
| Instruction | Caller | Effect |
| --- | --- | --- |
| `initialize_factory` | Admin (one-time) | Bootstraps the global factory PDA |
| `create_fund` | Anyone | Deploys new FundVault PDA + SPL Mint, registers manager |
| `buy` | Investor | Deposits USDC, mints fund tokens via vAMM, splits to liquid/active |
| `sell` | Investor | Burns fund tokens, applies exit fee tier, returns USDC |
| `manager_open_perp` | Manager only | CPI into Drift to open SOL/BTC/ETH perp |
| `manager_close_perp` | Manager only | CPI into Drift to close perp, settle PnL |
| `claim_performance_fee` | Manager | Withdraws accrued fee above HWM |
 
## 10. User Journey Walkthroughs
 
### 10.1 Fund Manager (Leader)
 
```
1. Connect Phantom (Devnet) at https://sol.hypers.fun
2. Click "Launch Fund" → set name, ticker, performance fee (e.g. 20%)
3. Upload fund logo → pinned to IPFS via /api/pinata/upload
4. Sign create_fund transaction → FundVault PDA + SPL Mint deployed
5. Share fund URL: https://sol.hypers.fun/vault/<fund_id>
6. Open SOL-PERP long via in-app trading panel → CPI to Drift
7. PnL streams into NAV in real time
8. Performance fee accrues automatically when NAV breaks HWM
```
 
### 10.2 Investor (Follower)
 
```
1. Browse funds at https://sol.hypers.fun → sort by 24h NAV change
2. Click into a fund → view live chart, manager track record, position
3. Enter USDC amount → see preview of fund tokens received
4. Sign buy transaction → tokens minted to wallet
5. Hold or trade fund token freely (it's an SPL token)
6. Burn tokens to exit at any time → exit fee tier auto-applied
```
 
## 11. Implementation Status
 
| Component | Status | Verification |
| --- | --- | --- |
| Anchor program (Rust) | ✅ Deployed Devnet | `5jmoeSiY3kyFhaipuiV1Six4sAwMetsEWNNCTBdfrEza` |
| Factory PDA | ✅ Initialized | `BifoNKMbqCWLuHpFyXABGiRC6W7Hty5RtakkUrK5USLN` |
| Fund creation flow | ✅ Live | https://sol.hypers.fun/launch |
| Buy / sell with vAMM | ✅ Live | Per-vault page |
| Drift SOL-PERP integration | ✅ Live | CPI verified |
| HWM performance fees | ✅ Live | Enforced on-chain |
| Tiered exit fees | ✅ Live | Enforced on-chain |
| IPFS metadata pinning | ✅ Live | `/api/pinata/upload` |
| Devnet USDC faucet | ✅ Live | https://sol.hypers.fun/faucet |
| Real-time NAV charts | ✅ Live | `lightweight-charts` |
| Multi-perp markets (BTC, ETH) | 🚧 In progress | — |
| Mainnet audit | 📋 Planned | Pre-mainnet milestone |
| Jupiter integration | 📋 Planned | Q-future |
 
## 12. Run Locally
 
**Prerequisites:** Node.js 18.18+, a Solana wallet (Phantom recommended) **set to Devnet**.
 
```bash
# 1. Install dependencies
npm install
 
# 2. Start dev server
npm run dev
 
# 3. Open http://localhost:3000
#    - Switch wallet to Devnet
#    - Hit /faucet for test SOL/USDC
#    - Connect and launch or buy
```
 
### Available Scripts
 
| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build |
| `npm run start` | Run production build |
| `npm run lint` | Lint with ESLint config |
 
## 13. Environment Variables
 
Create `.env.local` in the project root.
 
| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SOLANA_NETWORK` | No | `devnet` | Network selector. Mainnet not yet supported. |
| `NEXT_PUBLIC_RPC_URL` | No | `https://api.devnet.solana.com` | Custom RPC endpoint. |
| `PINATA_JWT` | Yes\* | — | For pinning fund metadata to IPFS. |
 
\* Only required for fund creation locally; browsing existing funds works without it.
 
## 14. Security Model
 
### 14.1 Threat Model
 
| Threat | Mitigation |
| --- | --- |
| Manager rugpull | Manager has trading delegate only; cannot withdraw user funds. All withdrawals are user-initiated burns of their own tokens. |
| Vault drain via Drift | Drift sub-account is owned by FundVault PDA; manager signs trades but cannot transfer funds out of Drift. |
| Oracle manipulation | NAV computed from Drift's Pyth-pegged perp valuations + USDC reserves. No custom oracle. |
| Re-entrancy | Anchor's account validation + checks-effects-interactions pattern enforced. |
| HWM evasion | HWM is monotonically increasing; updated atomically with NAV changes. |
| Front-running on buy/sell | Virtual AMM uses dynamic scaling, making sandwich attacks unprofitable on standard fund sizes. |
 
### 14.2 Audit Status
 
- **Hyperliquid contracts:** verified on [HyperEVMScan](https://hyperevmscan.io)
- **Solana contracts:** unaudited, Devnet-only — do not deposit real value
- **Mainnet path:** formal audit before any mainnet deployment
## 15. Roadmap
 
### Q1 (current — hackathon)
- [x] Anchor program deployed Devnet
- [x] Drift SOL-PERP integration via CPI
- [x] NAV-anchored virtual AMM
- [x] HWM performance fees + tiered exit fees
- [x] One-click fund launch with IPFS metadata
- [x] Real-time NAV charts and on-chain stats
### Q2
- [ ] Multi-market support (BTC-PERP, ETH-PERP, JUP-PERP)
- [ ] Manager leaderboard with on-chain track records
- [ ] Jupiter aggregator integration — fund tokens swappable as standard SPL liquidity
- [ ] Formal security audit
### Q3
- [ ] Solana mainnet launch
- [ ] Cross-chain manager profiles (HyperEVM ↔ Solana unified track record)
- [ ] Multi-perp DEX support (Zeta, Jupiter Perps as alternatives)
- [ ] Manager reputation NFTs (Tensor-tradeable)
### Q4
- [ ] Mobile-optimized launch flow
- [ ] Fund-of-funds aggregator (auto-rebalanced manager basket)
- [ ] DAO-governed protocol fee switch
## 16. Ecosystem
 
HypersFun is a multi-chain protocol. This Solana deployment is part of a broader ecosystem:
 
| Surface | URL | Status |
| --- | --- | --- |
| Hyperliquid version | [hypers.fun](https://hypers.fun) | Live on HyperEVM mainnet |
| Solana version | [sol.hypers.fun](https://sol.hypers.fun) | Devnet (this repo) |
| Protocol docs | [hyper-fun.gitbook.io](https://hyper-fun.gitbook.io/hyper.fun) | — |
| Twitter / X | [@hypersFun](https://x.com/hypersFun) | — |
 
### Hyperliquid Production Contracts (verified on HyperEVMScan)
 
| Contract | Type | Address |
| --- | --- | --- |
| HyperFunFactory | Proxy | `0xeE7dB1582e46c054792AdD4bb52b8D4D6ab45555` |
| HyperFunFactory | Implementation | `0xD52004ecD92D8004731BdB3758Cef51A808d2a57` |
| HyperFunToken | Implementation | `0xFa0A82a463F1501b86aaf415c1A1638ff7B0db7f` |
| HyperFunTrading | Implementation | `0x6086d078a06c4080113698E8548a53A7fdeeF364` |
 
## 17. Why This Matters
 
Crypto's "tradfi-on-chain" thesis has produced exchanges, lending markets, and stablecoins — but **active asset management remains the missing primitive**. Existing solutions are gated, illiquid, or both.
 
HypersFun closes this gap by collapsing three existing patterns into a single primitive:
 
1. The **launch UX of pump.fun** (one click, permissionless, free)
2. The **liquidity model of Uniswap** (always-on AMM, no LPs needed)
3. The **economic model of a hedge fund** (NAV, HWM, performance fees, active management)
The result is a primitive that is simultaneously accessible to retail (pump.fun-easy) and structured enough for serious capital (hedge-fund-grade accounting). Combined with Drift's deep perp liquidity, this brings real, institutional-style alpha to any wallet on Solana — without intermediaries.
 
## 18. License
 
Proprietary — all rights reserved.
 
Open-source migration (MIT or Apache-2.0) is on the roadmap post-audit.
 
For partnership, integration, audit, or licensing inquiries: [@hypersFun](https://x.com/hypersFun) on X.
 
---
 
**Built for hackathon submission. Solana Devnet only. Not financial advice. Smart contracts unaudited.**
