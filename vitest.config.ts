import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/packages/*/lib/**", "src/packages/*/index.ts"],
      // Test stand-ins are not product logic.
      exclude: ["src/packages/*/lib/fake/**"],
      thresholds: { lines: 85 },
    },
  },
});
