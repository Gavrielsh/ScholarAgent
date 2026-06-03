/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ["pg"],
    instrumentationHook: true,
  },
};

export default nextConfig;
