// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isList, isRecord } from "#src/component/shape.ts";
import convex from "@convex-dev/eslint-plugin";
import { ESLint } from "eslint";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ERROR = 2;
const CONVEX_RULES = 11;
const NONE = 0;
const RULE_CLASHES = 5;
const BANNED_NAMES = 1;
const PLUGINS = new Set([
  "eslint",
  "import",
  "jest",
  "jsdoc",
  "jsx_a11y",
  "nextjs",
  "node",
  "oxc",
  "promise",
  "react",
  "typescript",
  "unicorn",
  "vitest",
]);
const LEFT_OUT = {
  "import/no-default-export": "Convex needs the default export of convex.config.ts, schema.ts, http.ts and crons.ts.",
  "import/no-named-export": "Convex names each registered function after its named export.",
  "import/no-nodejs-modules": "The generator writes files, and the configs and this test run git and oxlint.",
  "no-undefined": "Convex removes a field from a document only when patch passes it undefined.",
  "oxc/no-async-await": "typescript/promise-function-async",
  "unicorn/no-null": "Convex has no undefined value, so the schema and the returns validators hold null.",
  "vitest/no-importing-vitest-globals": "vitest/prefer-importing-vitest-globals",
  "vitest/prefer-called-once": "vitest/prefer-called-times",
  "vitest/prefer-to-be-falsy": "vitest/prefer-strict-boolean-matchers",
  "vitest/prefer-to-be-truthy": "vitest/prefer-strict-boolean-matchers",
};

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.js"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => file !== "");
const rules = Object.keys(convex.rules).map((name) => `@convex-dev/${name}`);
const oxlint = `${root}/node_modules/.bin/oxlint`;
const listing: unknown = JSON.parse(
  execFileSync(oxlint, ["--rules", "--format=json"], { cwd: root, encoding: "utf8" }),
);
const printed: unknown = JSON.parse(execFileSync(oxlint, ["--print-config"], { cwd: root, encoding: "utf8" }));
const bans = readFileSync(`${root}/lint/banned-patterns.txt`, "utf8")
  .split("\n")
  .filter((line) => line !== "");

function entry(value: unknown, key: string): unknown {
  if (isRecord(value)) {
    return value[key];
  }
  return null;
}

function level(setting: unknown): unknown {
  if (isList(setting)) {
    return setting[0];
  }
  return setting;
}

function severity(config: unknown, rule: string): unknown {
  return level(entry(entry(config, "rules"), rule));
}

function text(value: unknown, key: string): string {
  const found = entry(value, key);
  if (typeof found === "string") {
    return found;
  }
  return "";
}

function ruleName(rule: unknown): string {
  const scope = text(rule, "scope");
  if (scope === "eslint") {
    return text(rule, "value");
  }
  return `${scope}/${text(rule, "value")}`;
}

function bannedBy(pattern: string, name: string): boolean {
  try {
    return new RegExp(pattern, "u").test(name);
  } catch {
    return false;
  }
}

function rulesOf(value: unknown): readonly unknown[] {
  if (isList(value)) {
    return value;
  }
  return [];
}

const registered = rulesOf(listing)
  .filter((rule) => PLUGINS.has(text(rule, "scope")))
  .map((rule) => ruleName(rule))
  .toSorted();
const running = new Set(registered.filter((name) => severity(printed, name) === "deny"));
const contradicted = Object.values(LEFT_OUT).filter((reason) => registered.includes(reason));
const banned = registered.filter((name) => bans.some((pattern) => bannedBy(pattern, name)));

describe("lint", () => {
  it("every Convex rule runs at error on every tracked file", { timeout: 30_000 }, async () => {
    expect.hasAssertions();
    const eslint = new ESLint({ cwd: root });
    const weaker = await Promise.all(
      files.map(async (file) => {
        const config: unknown = await eslint.calculateConfigForFile(file);
        return { file, rules: rules.filter((rule) => severity(config, rule) !== ERROR) };
      }),
    );
    expect(files).toContain("src/component/events.ts");
    expect(rules).toHaveLength(CONVEX_RULES);
    expect(weaker.filter((found) => found.rules.length > NONE)).toStrictEqual([]);
  });

  it(
    "every oxlint rule of the 13 plugins runs at error unless it clashes or the ban list names it",
    { timeout: 30_000 },
    () => {
      expect.hasAssertions();
      expect(registered).toContain("typescript/no-floating-promises");
      expect(registered.filter((name) => !running.has(name))).toStrictEqual(
        [...banned, ...Object.keys(LEFT_OUT)].toSorted(),
      );
      expect(banned).toHaveLength(BANNED_NAMES);
      expect(contradicted).toHaveLength(RULE_CLASHES);
      expect(contradicted.filter((rule) => !running.has(rule))).toStrictEqual([]);
    },
  );
});
