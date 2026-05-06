import type { Metadata } from 'next'
import './globals.css'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: 'HypersFun — Launch Your Onchain Fund | CopyFundFi Protocol on Solana',
  description: 'HypersFun is the CopyFundFi Protocol on Solana. Launch your onchain fund, tokenize your trading performance, and let investors copy your trades transparently in real time with zero custody risk.',
  keywords: 'CopyFundFi, Solana, onchain fund, copy trading, DeFi, tokenized fund, perpetual trading, crypto fund management',
  authors: [{ name: 'HypersFun' }],
  creator: 'HypersFun',
  publisher: 'HypersFun',
  icons: {
    icon: '/images/ico.png',
  },
  openGraph: {
    title: 'HypersFun — Launch Your Onchain Fund | CopyFundFi Protocol',
    description: 'Launch your onchain fund on Hyperliquid. Tokenize your trading performance and let investors copy your trades transparently.',
    url: 'https://hypers.fun',
    siteName: 'HypersFun',
    type: 'website',
    locale: 'en_US',
    images: [
      {
        url: 'https://hypers.fun/images/og-image.jpg',
        width: 1200,
        height: 630,
        alt: 'HypersFun — CopyFundFi Protocol on Hyperliquid',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'HypersFun — CopyFundFi Protocol on Hyperliquid',
    description: 'Launch your onchain fund, tokenize your trading performance, and let investors copy your trades.',
    creator: '@hypersFun',
    images: ['https://hypers.fun/images/og-image.jpg'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  alternates: {
    canonical: 'https://hypers.fun',
  },
}

// JSON-LD Structured Data
const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'HypersFun',
  url: 'https://hypers.fun',
  logo: 'https://hypers.fun/images/ico.png',
  description: 'The CopyFundFi Protocol on Solana — launch your onchain fund and let investors copy your trades transparently.',
  sameAs: ['https://x.com/hypersFun'],
}

const faqSchema = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is the CopyFundFi Protocol?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'CopyFundFi is a decentralized protocol on Solana that allows traders to launch onchain funds and let investors automatically copy their trades in real time. It combines copy trading with tokenized fund management and DeFi composability.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is HypersFun non-custodial?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes. HypersFun is fully onchain and non-custodial. Fund managers never hold investor assets directly. All funds are managed through smart contracts on Hyperliquid with complete transparency.',
      },
    },
    {
      '@type': 'Question',
      name: 'How are performance fees calculated?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Performance fees are calculated based on the profit generated above the high-water mark. Fund managers set their own fee percentage (up to 30%), and fees are only charged when investors realize profits upon selling their fund tokens.',
      },
    },
    {
      '@type': 'Question',
      name: 'What is NAV-anchored pricing?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'NAV-anchored pricing means the fund token price is tied to the Net Asset Value of the underlying assets. This ensures fair pricing based on actual fund performance, with a bonding curve mechanism for liquidity.',
      },
    },
    {
      '@type': 'Question',
      name: 'How do I launch a fund on HypersFun?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Launching a fund takes just one click. Connect your wallet, set your fund name, symbol, and performance fee, then deploy. Your fund token is immediately tradeable and you can start executing trades on Hyperliquid perpetuals.',
      },
    },
  ],
}

const webAppSchema = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'HypersFun',
  url: 'https://hypers.fun',
  applicationCategory: 'FinanceApplication',
  operatingSystem: 'Web',
  description: 'Launch and manage onchain funds on Solana with the CopyFundFi Protocol',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
  featureList: [
    'One-click fund creation',
    'NAV-anchored token pricing',
    'Integrated perpetual trading',
    'Non-custodial fund management',
    'Transparent onchain performance',
    'Automated copy trading',
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <link rel="canonical" href="https://hypers.fun/" />
        {/* Preload critical assets for LCP optimization */}
        <link rel="preload" href="/images/hero_section.webm" as="video" type="video/webm" />
        <link rel="preload" href="/images/hero_section_img.jpg" as="image" />
        {/* Preconnect to external domains */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(webAppSchema) }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
