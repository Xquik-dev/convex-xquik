import { execFileSync } from "node:child_process";

const mutate = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "src", "scripts", "example"],
  {
    encoding: "utf8",
  },
)
  .split("\n")
  .filter((file) => file.endsWith(".ts"));

export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.js" },
  coverageAnalysis: "perTest",
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  mutate,
  reporters: ["clear-text", "json", "progress"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 100, low: 100, break: 100 },
  concurrency: 8,
  timeoutMS: 10_000,
};
