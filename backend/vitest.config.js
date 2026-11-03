import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["./test/**/*.test.js"],
    testTimeout: 15000,
    hookTimeout: 15000,
    reporters: ["default"],
  },
});
