/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ["pg", "pdf-parse", "pdfjs-dist"],
    instrumentationHook: true,
  },
};

export default nextConfig;
