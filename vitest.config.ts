import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    setupFiles: ["./packages/kiro-core/test/setup.ts"],
  },
});
