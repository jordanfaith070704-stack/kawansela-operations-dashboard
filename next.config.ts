import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  typedRoutes: true,
  experimental: { serverActions: { bodySizeLimit: '1mb' } },
}

export default nextConfig
