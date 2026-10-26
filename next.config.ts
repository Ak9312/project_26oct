import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page reads live data (the index, the admin session), so the
  // static-shell caching modes are left off.
  cacheComponents: false,
  // pdf.js inside unpdf must stay a plain Node dependency on the server
  serverExternalPackages: ["unpdf", "mammoth"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
