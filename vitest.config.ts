import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      thresholds: {
        "packages/devtools/**": {
          statements: 60,
          branches: 55,
          functions: 65,
        },
      },
    },
  },
});
