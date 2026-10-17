import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev badge defaults to bottom-left, where it covers the sidebar footer.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
