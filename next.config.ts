import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 and the ffmpeg child-process layer are Node-native; keep them
  // out of the bundler so route handlers can require them at runtime.
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    // Long-running render routes stream progress; give them room.
    proxyTimeout: 600_000,
  },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
