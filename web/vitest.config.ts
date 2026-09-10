import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  // the feed tests render components to static markup; the automatic JSX runtime is what Next uses
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": here,
      // `server-only` throws outside a React Server Components bundler; the tests run the server code directly.
      "server-only": path.join(here, "test/server-only.ts"),
    },
  },
});
