'use client';

import { useState } from 'react';
import { ChevronDown, Shield, Zap, TrendingUp, Users, Lock, BarChart3, ChevronRight } from 'lucide-react';
import Link from 'next/link';

interface FAQItem {
  question: string;
  answer: string;
}

const faqs: FAQItem[] = [
  {
    question: 'What is the CopyFundFi Protocol?',
    answer: 'CopyFundFi is a decentralized protocol on Hyperliquid that allows traders to launch onchain funds and let investors automatically copy their trades in real time. It combines the best of copy trading, tokenized fund management, and DeFi composability into a single seamless experience.',
  },
  {
    question: 'Is HypersFun non-custodial?',
    answer: 'Yes. HypersFun is fully onchain and non-custodial. Fund managers never hold investor assets directly. All funds are managed through audited smart contracts on Hyperliquid with complete transparency. You always maintain control of your assets.',
  },
  {
    question: 'How are performance fees calculated?',
    answer: 'Performance fees are calculated based on the profit generated above the high-water mark. Fund managers set their own fee percentage (up to 30%), and fees are only charged when investors realize profits upon selling their fund tokens. This ensures managers are only rewarded for actual performance.',
  },
  {
    question: 'What is NAV-anchored pricing?',
    answer: 'NAV-anchored pricing means the fund token price is tied to the Net Asset Value of the underlying assets. This ensures fair pricing based on actual fund performance, with a bonding curve mechanism providing continuous liquidity for buying and selling fund tokens.',
  },
  {
    question: 'How do I launch a fund on HypersFun?',
    answer: 'Launching a fund takes just one click. Connect your wallet, set your fund name, symbol, and performance fee, then deploy. Your fund token is immediately tradeable and you can start executing trades on Hyperliquid perpetuals. The entire process takes less than a minute.',
  },
  {
    question: 'What trading features are available?',
    answer: 'Fund managers can trade all perpetual markets available on Hyperliquid with up to 50x leverage. This includes BTC, ETH, SOL, and 100+ other assets. All trades are executed onchain with real-time position tracking visible to all investors.',
  },
];

const features = [
  { icon: Zap, title: 'One-Click Launch', description: 'Deploy your tokenized fund in seconds' },
  { icon: TrendingUp, title: 'NAV-Anchored', description: 'Fair pricing tied to fund performance' },
  { icon: BarChart3, title: '100+ Markets', description: 'Trade perps with up to 50x leverage' },
  { icon: Shield, title: 'Non-Custodial', description: 'Zero custody risk, fully onchain' },
  { icon: Users, title: 'Transparent', description: 'Real-time position & PnL tracking' },
  { icon: Lock, title: 'Secure', description: 'Time-based fees align incentives' },
];

const steps = [
  { num: '1', title: 'Create Fund', desc: 'One-click deploy with custom fee' },
  { num: '2', title: 'Attract Investors', desc: 'They buy tokens, auto-copy trades' },
  { num: '3', title: 'Earn Fees', desc: 'Performance fee on profits only' },
];

export default function SEOContent() {
  const [expanded, setExpanded] = useState(false);
  const [openFAQ, setOpenFAQ] = useState<number | null>(null);

  return (
    <section className="border-t border-border bg-gradient-to-b from-transparent to-black/20">
      <div className="w-full px-2 sm:px-4">

        {/* Compact Header - Always Visible */}
        <div className="py-8 sm:py-12">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
            {/* Left: Title + Description */}
            <div className="flex-1">
              <h2 className="text-xl sm:text-2xl font-black uppercase tracking-tight text-white mb-2">
                The <span className="text-primary">CopyFundFi</span> Protocol
              </h2>
              <p className="text-gray-400 text-sm max-w-2xl">
                Launch onchain funds on Hyperliquid. Tokenize your trading performance and let investors copy your trades transparently with zero custody risk.
              </p>
            </div>

            {/* Right: CTA Buttons */}
            <div className="flex items-center gap-3">
              <Link
                href="/launch"
                className="px-5 py-2.5 bg-primary text-black font-bold text-xs uppercase tracking-widest hover:bg-primary/80 transition-colors"
              >
                Launch Fund
              </Link>
              <button
                onClick={() => setExpanded(!expanded)}
                className="px-4 py-2.5 border border-border text-gray-400 font-bold text-xs uppercase tracking-widest hover:border-primary/40 hover:text-white transition-colors flex items-center gap-2 cursor-pointer"
              >
                Learn More
                <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
            </div>
          </div>

          {/* Features Strip - Always Visible */}
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {features.map((feature, index) => (
              <div key={index} className="bg-black/40 border border-border/50 hover:border-primary/30 transition-colors px-4 py-4 flex items-start gap-3">
                <feature.icon className="w-6 h-6 text-primary shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-xs sm:text-sm font-bold text-white uppercase">{feature.title}</div>
                  <div className="text-[10px] sm:text-xs text-gray-500 mt-0.5">{feature.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Expandable Content */}
        {expanded && (
          <div className="pb-12 space-y-12 border-t border-border/50 pt-8 animate-in fade-in slide-in-from-top-4 duration-300">

            {/* How It Works - Compact */}
            <div>
              <h3 className="text-lg font-black uppercase tracking-tight text-white mb-4 flex items-center gap-2">
                <ChevronRight className="w-5 h-5 text-primary" />
                How It Works
              </h3>
              <div className="grid sm:grid-cols-3 gap-3">
                {steps.map((step, index) => (
                  <div key={index} className="bg-card border border-border p-4 flex items-start gap-3">
                    <div className="w-7 h-7 bg-primary text-black font-black flex items-center justify-center text-sm shrink-0">
                      {step.num}
                    </div>
                    <div>
                      <div className="text-sm font-bold text-white">{step.title}</div>
                      <div className="text-xs text-gray-500">{step.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* About - Two Columns Compact */}
            <div>
              <h3 className="text-lg font-black uppercase tracking-tight text-white mb-4 flex items-center gap-2">
                <ChevronRight className="w-5 h-5 text-primary" />
                About CopyFundFi
              </h3>
              <div className="grid md:grid-cols-2 gap-6 text-gray-400 text-sm leading-relaxed">
                <div className="space-y-3">
                  <p>
                    <strong className="text-white">HypersFun</strong> introduces CopyFundFi — a revolutionary way to launch and manage onchain funds on Hyperliquid.
                    Traders tokenize their performance, allowing investors to automatically copy trades with complete transparency.
                  </p>
                  <p>
                    Unlike traditional copy trading, CopyFundFi creates a tokenized fund where your strategy becomes an investable asset.
                    Fund managers earn performance fees only on profits, ensuring aligned incentives.
                  </p>
                </div>
                <div className="space-y-3">
                  <p>
                    Built on Hyperliquid with up to <strong className="text-white">50x leverage</strong>, sub-second execution, and complete onchain transparency.
                    The protocol uses <strong className="text-white">NAV-anchored pricing</strong> with a bonding curve for continuous liquidity.
                  </p>
                  <p>
                    Security is paramount — fully non-custodial with all operations through audited smart contracts.
                    Time-based exit fees prevent exploitation while rewarding long-term investors.
                  </p>
                </div>
              </div>
            </div>

            {/* FAQ - Compact Grid */}
            <div>
              <h3 className="text-lg font-black uppercase tracking-tight text-white mb-4 flex items-center gap-2">
                <ChevronRight className="w-5 h-5 text-primary" />
                FAQ
              </h3>
              <div className="grid sm:grid-cols-2 gap-2">
                {faqs.map((faq, index) => (
                  <div key={index} className="border border-border bg-card/50">
                    <button
                      onClick={() => setOpenFAQ(openFAQ === index ? null : index)}
                      className="w-full px-4 py-3 flex items-center justify-between text-left cursor-pointer hover:bg-white/5 transition-colors"
                    >
                      <span className="font-bold text-white text-xs sm:text-sm pr-2">{faq.question}</span>
                      <ChevronDown
                        className={`w-4 h-4 text-primary shrink-0 transition-transform ${openFAQ === index ? 'rotate-180' : ''}`}
                      />
                    </button>
                    {openFAQ === index && (
                      <div className="px-4 pb-3 text-gray-400 text-xs leading-relaxed border-t border-border/50 pt-3">
                        {faq.answer}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}

      </div>
    </section>
  );
}
