import { defineConfig } from "vitest/config";
import { resolve } from "path";

// The default project — plain unit tests (`bun run test` / `make test`).
// `@raycast/api`/`@raycast/utils` are aliased to the fakes under src/e2e so a
// unit test can import a module that touches LocalStorage/environment/etc.
// without a per-file `vi.mock`; the e2e fixture/live suites live in a
// separate project (vitest.e2e.config.ts) with their own include pattern.
export default defineConfig({
  resolve: {
    alias: {
      "@raycast/api": resolve(__dirname, "src/e2e/raycast-fake.tsx"),
      "@raycast/utils": resolve(__dirname, "src/e2e/raycast-utils-fake.tsx"),
    },
  },
  test: {
    exclude: ["**/node_modules/**", "src/e2e/**/*.e2e.test.tsx"],
  },
});
