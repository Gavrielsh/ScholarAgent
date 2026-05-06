/** @type {import('next').NextConfig} */
const nextConfig = {
  // Node.js built-ins used by lib/chat/history.ts (fs/promises, path, crypto).
  // Next.js App Router runs on the Edge by default for some routes; these
  // server-side modules require the Node.js runtime.
  experimental: {
    serverComponentsExternalPackages: ["pg"],
  },
};

export default nextConfig;
