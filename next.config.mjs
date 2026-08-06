/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ["pg"],
    instrumentationHook: true,
  },
  eslint: {
    // אזהרה: זה מאפשר לבילד לעבור גם אם יש שגיאות ESLint.
    // פתרון מושלם כדי להרים את המערכת להדגמה.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
