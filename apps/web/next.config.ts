import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // plain Node server, no host lock-in (SPEC §2a); one image runs web or worker
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
  transpilePackages: ["@eci-shuttle/shared"],
  env: {
    NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME ?? "",
  },
};

export default nextConfig;
