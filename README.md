# HypersFun — CopyFundFi Protocol on Solana

HypersFun lets traders launch onchain funds in a single click and lets investors copy those funds transparently in real time. Funds are tokenized, NAV-anchored, and fully non-custodial — settled through Anchor programs on Solana with Drift Protocol providing the perpetuals venue.

Live site: <https://sol.hypers.fun/>

> ⚠️ **Solana Devnet only.** HypersFun currently runs exclusively on **Solana Devnet**. Make sure your wallet (Phantom / Solflare / etc.) is switched to **Devnet** before connecting — connecting on Mainnet will not work. Use the in-app [/faucet](https://sol.hypers.fun/faucet) page to get test SOL and USDC.

## Features

- **One-click fund launch** — deploy a tokenized fund with a name, symbol, and performance fee (up to 30%).
- **NAV-anchored pricing** — fund token price tracks Net Asset Value via a bonding curve.
- **Integrated perp trading** — managers route trades through Drift Protocol perpetuals.
- **Non-custodial** — investor assets stay in onchain vaults; no manager custody.
- **High-water-mark performance fees** — fees only accrue on realized profits above prior peaks.
- **Tiered exit fees** — discourage short-term churn (15% < 3d, 8% 3–7d, 3% 7–30d, 0% > 30d).
- **Lightweight charting** — candle/price charts and on-chain stats per vault.
- **Devnet faucet** — request test USDC for trying the protocol on devnet.

## Tech Stack

- **Framework:** Next.js 15 (App Router) + React 19 + TypeScript
- **Styling:** Tailwind CSS 4
- **Chain:** Solana — `@solana/web3.js`, `@coral-xyz/anchor`, `@solana/spl-token`
- **Wallets:** Phantom, Solflare, Ledger, Torus via `@solana/wallet-adapter-*`
- **Trading venue:** Drift Protocol (perpetuals)
- **Charts:** `lightweight-charts`, `recharts`
- **State / data:** `@tanstack/react-query`
- **Storage:** Pinata (IPFS) for fund metadata + images

## Project Layout

```
app/                  Next.js App Router pages and API routes
  api/                Server routes (pinata upload, balance, lifi, vault candles)
  vault/[id]/         Per-vault page (chart, trade panel, stats)
  launch/             Launch a new fund
  create-l1/          Create a new L1 fund flow
  profile/            Connected wallet profile
  faucet/             Devnet USDC faucet
components/           Shared UI (Header, Footer, TokenCard, Hero, charts...)
  bonding-curve-vault/  Vault-specific UI (PriceChart, MarginTradingPanel, AdvancedChart)
lib/
  contracts/          Program config, IDL types, margin helpers
  vaults.ts           Vault loader / list aggregation
  vault-events.ts     On-chain event subscriptions
  indicators.ts       Chart indicators
  hooks/              React hooks (e.g. useFactoryStats)
public/images/        Static assets (logo, hero video, OG image)
programs/             Anchor smart contracts (Rust) — the on-chain HypersFun program
```

Key contract config lives in [lib/contracts/config.ts](lib/contracts/config.ts) — switch between `devnet` and `mainnet-beta` via `NEXT_PUBLIC_SOLANA_NETWORK`.

## Run Locally

**Prerequisites:** Node.js 18.18+ and a Solana wallet (Phantom recommended) **set to Solana Devnet**.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create `.env.local` in the project root and set the variables you need (see below).
3. Start the dev server:
   ```bash
   npm run dev
   ```
4. Open <http://localhost:3000>, switch your wallet to **Solana Devnet**, then connect. Grab test SOL/USDC from the [/faucet](http://localhost:3000/faucet) page before launching or buying into a vault.

### Scripts

| Command         | Purpose                              |
| --------------- | ------------------------------------ |
| `npm run dev`   | Start the Next.js dev server         |
| `npm run build` | Production build                     |
| `npm run start` | Run the production build             |
| `npm run lint`  | Lint with the Next.js ESLint config  |

## Environment Variables

Create a `.env.local` file (it is git-ignored). All `NEXT_PUBLIC_*` values are exposed to the browser.

> HypersFun is **Devnet-only** for now — the Devnet program ID, factory PDA, USDC mint, and Drift addresses are all hard-coded in [lib/contracts/config.ts](lib/contracts/config.ts), so you don't need any env vars to try the app out on Devnet.

| Variable                       | Required | Description                                                                          |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_SOLANA_NETWORK`   | No       | Must stay as `devnet` (the default). HypersFun does not support Mainnet yet.         |
| `NEXT_PUBLIC_RPC_URL`          | No       | Override the default Devnet RPC (`https://api.devnet.solana.com`) with your own.     |
| `PINATA_JWT`                   | Yes\*    | Pinata JWT used by `/api/pinata/upload` to pin fund metadata + images to IPFS.       |

<sub>\* Only required if you launch new vaults locally. Browsing existing vaults works without it.</sub>

## How It Works

1. A trader creates a fund — name, symbol, and performance fee (≤ 30%) — and deploys via the factory.
2. Investors mint fund tokens by depositing USDC; price is anchored to NAV via a bonding curve.
3. The manager opens/closes perp positions on Drift; PnL flows back into NAV transparently.
4. Investors redeem at NAV minus the relevant exit-fee tier; performance fees accrue only above the high-water mark.

## Deployment

The app is built for Vercel-style platforms. Set the environment variables above in your host, keep `NEXT_PUBLIC_SOLANA_NETWORK=devnet` (HypersFun is Devnet-only for now), and run `npm run build`.

## License

Proprietary — all rights reserved unless stated otherwise.
