import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  compiler: {
    // 在 production 環境移除 console.log, console.debug, console.info
    removeConsole: process.env.NODE_ENV === 'production'
      ? {
          exclude: ['error', 'warn'], // 保留 error 和 warn
        }
      : false,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cyan-defeated-lemming-99.mypinata.cloud',
        pathname: '/ipfs/**',
      },
      {
        protocol: 'https',
        hostname: '*.mypinata.cloud',
        pathname: '/ipfs/**',
      },
    ],
    // 緩存優化 - 5 分鐘緩存，平衡性能和即時性
    minimumCacheTTL: 60 * 5,
    // 優化圖片格式
    formats: ['image/avif', 'image/webp'],
  },
  // Security Headers
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ]
  },
}

export default nextConfig