import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    reporters: ["default"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
