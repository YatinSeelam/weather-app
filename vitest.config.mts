import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname) },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
    // Tests never touch the on-disk caches or the real monitor store.
    env: { WEATHER_DISK_CACHE: "off" },
    restoreMocks: true,
  },
});
