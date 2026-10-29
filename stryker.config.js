const config = {
  checkers: ["typescript"],
  concurrency: "100%",
  coverageAnalysis: "perTest",
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  reporters: ["clear-text", "json", "progress"],
  testRunner: "vitest",
  thresholds: { break: 100, high: 100, low: 100 },
  timeoutMS: 10_000,
  tsconfigFile: "tsconfig.stryker.json",
  vitest: { configFile: "vitest.config.js" },
};

export default config;
