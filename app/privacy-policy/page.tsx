'use client'

import Header from '@/components/Header';
import Footer from '@/components/Footer';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-dark flex flex-col text-white">
      <Header
        searchQuery=""
        onSearchChange={() => {}}
        onLogoClick={() => window.location.href = '/'}
      />

      <main className="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="space-y-4 sm:space-y-6 text-sm sm:text-base text-gray-300 leading-relaxed bg-dark-secondary/30 border border-border rounded-lg p-4 sm:p-6 md:p-8 shadow-lg">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold mb-6 sm:mb-8 text-primary uppercase tracking-wider underline">Privacy Policy</h1>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">1. Information Collection</h2>
            <p>
              HyperVapor Fun is a decentralized platform that interacts with blockchain networks. We do not collect personal information
              in the traditional sense. However, your blockchain wallet address and transaction history are publicly visible on the blockchain.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">2. Blockchain Data</h2>
            <p>
              When you use our Platform, your interactions are recorded on public blockchain networks. This includes:
            </p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li>Wallet addresses</li>
              <li>Transaction amounts and timestamps</li>
              <li>Smart contract interactions</li>
              <li>Token holdings and transfers</li>
            </ul>
            <p className="mt-2">
              This information is permanently recorded on the blockchain and cannot be modified or deleted.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">3. Website Analytics</h2>
            <p>
              We may use third-party analytics tools to understand how users interact with our Platform. This may include:
            </p>
            <ul className="list-disc list-inside ml-2 sm:ml-4 mt-2 space-y-1 sm:space-y-2">
              <li>Browser type and version</li>
              <li>Pages visited and time spent</li>
              <li>Device information</li>
              <li>IP addresses (anonymized)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">4. Cookies</h2>
            <p>
              Our Platform may use cookies and similar technologies to enhance user experience and maintain session information.
              You can disable cookies in your browser settings, though this may affect functionality.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">5. Third-Party Services</h2>
            <p>
              Our Platform may integrate with third-party services such as wallet providers, blockchain explorers, and analytics tools.
              These services have their own privacy policies which govern their use of your information.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">6. Data Security</h2>
            <p>
              While we implement reasonable security measures to protect our Platform, the decentralized nature of blockchain technology
              means that you are primarily responsible for securing your own wallet and private keys. Never share your private keys or
              seed phrases with anyone.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">7. Children's Privacy</h2>
            <p>
              Our Platform is not intended for use by individuals under the age of 18. We do not knowingly collect information from minors.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">8. Changes to Privacy Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. Continued use of the Platform after changes constitutes acceptance
              of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2 sm:mb-3 uppercase tracking-wide">9. Contact Information</h2>
            <p>
              If you have questions about this Privacy Policy, please contact us through our official social media channels listed
              on the Platform.
            </p>
          </section>

          <p className="text-xs sm:text-sm text-gray-500 mt-6 sm:mt-8 pt-6 sm:pt-8 border-t border-border">
            Last updated: February 2026
          </p>
        </div>
      </main>

      <Footer />
    </div>
  );
}
