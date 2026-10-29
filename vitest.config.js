import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "src", "scripts", "example"],
  {
    encoding: "utf8",
  },
)
  .split("\n")
  .filter((file) => file.endsWith(".ts"));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^xquik-convex\/convex\.config\.js$/,
        replacement: fileURLToPath(new URL("src/component/convex.config.ts", import.meta.url)),
      },
      { find: /^xquik-convex$/, replacement: fileURLToPath(new URL("src/client/index.ts", import.meta.url)) },
    ],
  },
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: tracked,
      reporter: ["text-summary", "lcov", "json-summary"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
