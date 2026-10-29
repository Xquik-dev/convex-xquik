const config = {
  checkers: ["typescript"],
  concurrency: 8,
  coverageAnalysis: "perTest",
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  reporters: ["clear-text", "json", "progress"],
  testRunner: "vitest",
  thresholds: { break: 100, high: 100, low: 100 },
  timeoutMS: 10_000,
  tsconfigFile: "tsconfig.json",
  vitest: { configFile: "vitest.config.js" },
};

export default config;
