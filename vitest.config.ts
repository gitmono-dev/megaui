import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // FS-92: Web keeps JSX for Next; component tests need the same React runtime.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": path.resolve(repoRoot, "apps/web"),
    },
  },
  test: {
    passWithNoTests: false,
    setupFiles: ["apps/web/tests/contract/load-env.ts", "tests/setup-localstorage.ts"],
    include: [
      "apps/**/*.{test,spec}.{ts,tsx}",
      "packages/**/*.{test,spec}.{ts,tsx}",
      "tests/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/tests/e2e/**",
    ],
  },
});
