import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  poweredByHeader: false,
  transpilePackages: ["@openpond/continual-bench"],
};

export default nextConfig;
