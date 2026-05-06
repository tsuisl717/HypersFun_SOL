'use client'

import Header from '@/components/Header';
import Footer from '@/components/Footer';

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Header
        searchQuery=""
        onSearchChange={() => {}}
        onLogoClick={() => window.location.href = '/'}
      />

      <main className="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="space-y-4 sm:space-y-6 text-sm sm:text-base text-gray-300 leading-relaxed bg-dark-secondary/30 border border-border rounded-lg p-4 sm:p-6 md:p-8 shadow-lg">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold mb-6 sm:mb-8 text-primary uppercase tracking-wider underline">Terms of Service</h1>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">1. Acceptance of Terms</h2>
            <p>
              By accessing and using HyperVapor Fun (the "Platform", "Service", "we", "us", or "our"), you ("User", "you", or "your")
              accept and agree to be bound by these Terms of Service and all applicable laws and regulations. If you do not agree with
              any part of these terms, you must not use this Platform.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">2. Platform Description</h2>
            <p>
              HyperVapor Fun is a decentralized finance (DeFi) platform that provides:
            </p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li>Access to trading vaults with automated strategies</li>
              <li>Token trading and swap functionality via decentralized protocols</li>
              <li>Cross-chain bridge services through third-party integrations</li>
              <li>Vault creation and management tools for leaders</li>
              <li>Real-time market data and analytics</li>
            </ul>
            <p className="mt-4">
              The Platform interfaces with blockchain networks and smart contracts. We do not custody, control, or have access to your
              funds at any time. All transactions are executed directly on-chain through your connected wallet.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">3. Risk Disclosure and Warnings</h2>
            <p className="font-bold text-yellow-400 mb-3">⚠️ IMPORTANT: READ CAREFULLY</p>
            <p>
              Using the Platform involves significant risks, including but not limited to:
            </p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li><strong>Loss of Funds:</strong> You may lose some or all of your invested capital. Cryptocurrency values can be extremely volatile.</li>
              <li><strong>Smart Contract Risk:</strong> Smart contracts may contain bugs, vulnerabilities, or behave unexpectedly.</li>
              <li><strong>Market Risk:</strong> Cryptocurrency markets are highly volatile and unpredictable.</li>
              <li><strong>Liquidity Risk:</strong> You may not be able to exit positions at desired times or prices.</li>
              <li><strong>Regulatory Risk:</strong> Regulatory changes may affect the availability or legality of the Platform.</li>
              <li><strong>Technology Risk:</strong> Blockchain networks may experience outages, congestion, or attacks.</li>
              <li><strong>Impermanent Loss:</strong> Providing liquidity or participating in certain strategies may result in impermanent loss.</li>
              <li><strong>No Insurance:</strong> Unlike traditional banks, cryptocurrency transactions are not insured by any government agency.</li>
            </ul>
            <p className="mt-4 font-semibold">
              DO NOT invest more than you can afford to lose. Past performance is not indicative of future results.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">4. User Responsibilities</h2>
            <p>You are solely responsible for:</p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li>Maintaining the security of your wallet, private keys, seed phrases, and login credentials</li>
              <li>All transactions initiated through your wallet</li>
              <li>Evaluating the risks and conducting your own due diligence before making any investment decisions</li>
              <li>Complying with all applicable tax obligations in your jurisdiction</li>
              <li>Ensuring your use of the Platform complies with all local laws and regulations</li>
              <li>Paying all blockchain transaction fees (gas fees) associated with your transactions</li>
              <li>Verifying transaction details before confirmation</li>
            </ul>
            <p className="mt-4 font-semibold text-red-400">
              WARNING: We cannot reverse, cancel, or refund transactions. Blockchain transactions are irreversible once confirmed.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">5. Prohibited Activities</h2>
            <p>You agree NOT to:</p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li>Engage in any market manipulation, wash trading, or other fraudulent trading activities</li>
              <li>Use the Platform for money laundering, terrorist financing, or other illegal activities</li>
              <li>Attempt to gain unauthorized access to the Platform or its systems</li>
              <li>Use bots, scripts, or automated tools without authorization</li>
              <li>Interfere with or disrupt the Platform's operation</li>
              <li>Violate any applicable laws or regulations</li>
              <li>Impersonate others or provide false information</li>
              <li>Reverse engineer, decompile, or attempt to extract source code</li>
            </ul>
            <p className="mt-4">
              Violation of these terms may result in immediate termination of your access to the Platform and potential legal action.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">6. Fees and Charges</h2>
            <p>
              The Platform may charge various fees, including but not limited to:
            </p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li><strong>Performance Fees:</strong> Vault leaders may charge performance fees on profits (displayed on each vault)</li>
              <li><strong>Trading Fees:</strong> Fees may apply to swaps and trades</li>
              <li><strong>Gas Fees:</strong> Blockchain transaction fees paid to network validators (not controlled by us)</li>
              <li><strong>Bridge Fees:</strong> Cross-chain transfer fees charged by third-party bridge providers</li>
            </ul>
            <p className="mt-4">
              All fees are disclosed before transaction confirmation. We reserve the right to modify fee structures with notice.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">7. Third-Party Services and Integrations</h2>
            <p>
              The Platform integrates with third-party services including wallet providers (Rainbow, WalletConnect), bridge services
              (LI.FI), blockchain explorers, and price data providers. We do not control these services and are not responsible for
              their availability, accuracy, or security. Use of third-party services is subject to their respective terms and conditions.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">8. Disclaimer of Warranties</h2>
            <p>
              THE PLATFORM IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
              INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT.
            </p>
            <p className="mt-4">
              We do not warrant that:
            </p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li>The Platform will be uninterrupted, secure, or error-free</li>
              <li>Defects will be corrected</li>
              <li>The Platform is free from viruses or harmful components</li>
              <li>Results obtained from using the Platform will be accurate or reliable</li>
              <li>Data displayed on the Platform is accurate, complete, or current</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">9. Limitation of Liability</h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, HYPERVAPOR FUN, ITS AFFILIATES, OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, AND
              LICENSORS SHALL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES,
              INCLUDING BUT NOT LIMITED TO:
            </p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li>Loss of profits, revenue, or data</li>
              <li>Loss of cryptocurrency or digital assets</li>
              <li>Business interruption</li>
              <li>Personal injury or property damage</li>
              <li>Unauthorized access to your wallet or transactions</li>
            </ul>
            <p className="mt-4">
              This limitation applies regardless of the cause of action, whether in contract, tort, negligence, or otherwise,
              even if we have been advised of the possibility of such damages.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">10. Indemnification</h2>
            <p>
              You agree to indemnify, defend, and hold harmless HyperVapor Fun and its affiliates from any claims, losses, damages,
              liabilities, and expenses (including legal fees) arising from:
            </p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li>Your use or misuse of the Platform</li>
              <li>Your violation of these Terms of Service</li>
              <li>Your violation of any applicable laws or regulations</li>
              <li>Your violation of any third-party rights</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">11. Intellectual Property</h2>
            <p>
              All content, trademarks, logos, service marks, trade names, and intellectual property on the Platform are owned by or
              licensed to HyperVapor Fun. You may not copy, reproduce, distribute, modify, or create derivative works without our
              express written permission.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">12. Privacy</h2>
            <p>
              Your use of the Platform is also governed by our Privacy Policy. Please review our Privacy Policy to understand our
              practices regarding data collection and use.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">13. Modifications to the Platform and Terms</h2>
            <p>
              We reserve the right to:
            </p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li>Modify, suspend, or discontinue the Platform at any time without notice</li>
              <li>Update these Terms of Service at our discretion</li>
              <li>Change fees or introduce new features</li>
            </ul>
            <p className="mt-4">
              Continued use of the Platform after modifications constitutes acceptance of the updated terms. Material changes will
              be communicated through the Platform or our official channels.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">14. Termination</h2>
            <p>
              We may suspend or terminate your access to the Platform at any time, without notice, for any reason, including violation
              of these terms. Upon termination, your right to use the Platform immediately ceases. Sections that by their nature should
              survive termination shall survive, including disclaimers, limitations of liability, and indemnification provisions.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">15. Governing Law and Dispute Resolution</h2>
            <p>
              These Terms shall be governed by and construed in accordance with applicable laws, without regard to conflict of law
              principles. Any disputes arising from these Terms or use of the Platform shall be resolved through binding arbitration
              in accordance with applicable arbitration rules, except where prohibited by law.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">16. Severability</h2>
            <p>
              If any provision of these Terms is found to be invalid or unenforceable, the remaining provisions shall remain in full
              force and effect. The invalid provision shall be modified to the minimum extent necessary to make it valid and enforceable.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">17. Entire Agreement</h2>
            <p>
              These Terms of Service, together with our Privacy Policy, constitute the entire agreement between you and HyperVapor Fun
              regarding the use of the Platform and supersede all prior agreements and understandings.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">18. Contact Information</h2>
            <p>
              If you have questions about these Terms of Service, please contact us through our official social media channels
              listed on the Platform.
            </p>
          </section>

          <div className="bg-primary/10 border border-primary/30 rounded p-4 sm:p-6 mt-6 sm:mt-8">
            <p className="text-primary font-bold mb-2 text-sm sm:text-base">⚡ ACKNOWLEDGMENT</p>
            <p className="text-xs sm:text-sm">
              BY USING THE PLATFORM, YOU ACKNOWLEDGE THAT YOU HAVE READ, UNDERSTOOD, AND AGREE TO BE BOUND BY THESE TERMS OF SERVICE.
              YOU FURTHER ACKNOWLEDGE THE RISKS INVOLVED IN CRYPTOCURRENCY TRADING AND DEFI ACTIVITIES, AND ACCEPT FULL RESPONSIBILITY
              FOR YOUR INVESTMENT DECISIONS.
            </p>
          </div>

          <p className="text-xs sm:text-sm text-gray-500 mt-6 sm:mt-8 pt-6 sm:pt-8 border-t border-border">
            Last updated: February 10, 2026
          </p>
        </div>
      </main>

      <Footer />
    </div>
  );
}
