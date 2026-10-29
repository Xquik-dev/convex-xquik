import { defineConfig } from "vitest/config";

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
      provider: "v8",
      reporter: ["text-summary", "lcov", "json", "json-summary"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
    environment: "edge-runtime",
    include: ["test/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
