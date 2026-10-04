import { defineConfig } from "vitest/config";

// This package is a standalone npm module that happens to live inside the Mathter repo. Without
// a config of its own, `vitest` run from here walks UP and finds the app's /vitest.config.ts,
// whose `include` is the app's own `tests/**` -- so it would report "No test files found".
// The app's runner, in turn, never picks these up: its include list is an allowlist rooted at
// `tests/`, and `mcp/test/` is not in it. The two suites are deliberately separate -- this one
// needs no Supabase env, no jsdom and no app aliases.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
