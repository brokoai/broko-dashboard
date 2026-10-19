import type { NextConfig } from "next";

// cacheComponents / partialPrefetching are intentionally off: every route in
// this app depends on the signed-in user's session, so nothing can be prerendered.
const nextConfig: NextConfig = {
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
