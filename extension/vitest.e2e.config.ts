import { defineConfig } from "vitest/config";
import { resolve } from "path";

// The end-to-end render harness — mounts every command's real React tree
// (via react-test-renderer, see src/e2e/render.ts) against the fake
// @raycast/api/@raycast/utils so a crash like the speed-test null-record bug
// is caught here instead of in Tinycast. `make e2e` runs the fixture suites;
// `E2E_LIVE=1 make e2e-live` additionally exercises the read-only live suite
// (src/e2e/live.e2e.test.tsx, self-skipping without the env var).
export default defineConfig({
  resolve: {
    alias: {
      "@raycast/api": resolve(__dirname, "src/e2e/raycast-fake.tsx"),
      "@raycast/utils": resolve(__dirname, "src/e2e/raycast-utils-fake.tsx"),
    },
  },
  test: {
    include: ["src/e2e/**/*.e2e.test.tsx"],
    environment: "node",
    setupFiles: ["src/e2e/setup.ts"],
    testTimeout: 20_000,
  },
});
