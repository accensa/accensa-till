import type { NextConfig } from "next";

/**
 * Single origin for the browser (A5, UI-1): the dashboard only ever talks to
 * its own host, and this rewrite moves /api/* onto the API process. That keeps
 * the session cookie first-party, which is what makes a signed-cookie session
 * safe without CORS.
 *
 * The A5 acceptance check is that a request to /api/healthz reaches the API
 * through this rewrite — it needs a running API, so it is not verified here.
 */
const API_ORIGIN = (process.env.API_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_ORIGIN}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
