import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/packages/*/lib/**", "src/packages/*/index.ts"],
      // Test stand-ins and the thin wrapper around the installed program are not product logic.
      exclude: [
        "src/packages/*/lib/fake/**",
        "src/packages/science-daemon/lib/real-science-cli.ts",
      ],
      thresholds: { lines: 85 },
    },
  },
});
