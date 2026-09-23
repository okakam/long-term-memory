import type { NextConfig } from "next";
import { buildContentSecurityPolicy } from './src/lib/security/content-security-policy';

const commonSecurityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
];

const contentSecurityPolicyHeader = {
  key: 'Content-Security-Policy',
  value: buildContentSecurityPolicy(),
};

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  async headers() {
    return [
      { source: '/(.*)', headers: commonSecurityHeaders },
      { source: '/((?!oauth/authorize$).*)', headers: [contentSecurityPolicyHeader] },
    ];
  },
};

export default nextConfig;
