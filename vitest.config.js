import { defineConfig } from "vitest/config";
import { execFileSync } from "node:child_process";

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
        find: /^xquik-convex\/convex\.config\.js$/u,
        replacement: `${import.meta.dirname}/src/component/convex.config.ts`,
      },
      { find: /^xquik-convex$/u, replacement: `${import.meta.dirname}/src/client.ts` },
    ],
  },
  test: {
    coverage: {
      include: tracked,
      provider: "v8",
      reporter: ["text-summary", "lcov", "json-summary"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
    environment: "edge-runtime",
    include: ["test/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
