import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // apps/web is an independent workspace: its react deps live under
    // apps/web/node_modules and are not hoisted to the root, so the root
    // `vitest run` cannot resolve react/jsx-dev-runtime for web tests.
    // Those run from apps/web via the CI "Web UI tests" step instead.
    include: [
      "packages/**/*.{test,spec}.ts",
      "apps/api/**/*.{test,spec}.ts",
      "apps/analysis-worker/**/*.{test,spec}.ts",
      "apps/index-worker/**/*.{test,spec}.ts",
      "apps/scheduler/**/*.{test,spec}.ts",
    ],
  },
});
