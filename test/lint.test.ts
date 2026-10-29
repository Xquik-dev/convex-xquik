// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isList, isRecord, none } from "#src/component/shape.ts";
import convex from "@convex-dev/eslint-plugin";
import { ESLint } from "eslint";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ERROR = 2;
const CONVEX_RULES = 11;
const NONE = 0;
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
  "import/no-default-export": "Convex codegen fails unless convex.config.ts has a default export.",
  "import/no-named-export": "Convex names each function after its export, so a default export renames events.list.",
  "import/no-nodejs-modules": "The generator writes files, and the configs and this test run git and oxlint.",
  "oxc/no-async-await": "A mutation must await what it reads, and the then and plain Promise forms fail other rules.",
  "vitest/no-importing-vitest-globals":
    "An alias such as it as check hides each test from require-hook and expect-expect.",
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
  return none;
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
    "every oxlint rule of the 13 plugins runs at error except the ones a failing proof keeps out",
    { timeout: 30_000 },
    () => {
      expect.hasAssertions();
      expect(registered).toContain("typescript/no-floating-promises");
      expect(registered.filter((name) => !running.has(name))).toStrictEqual(Object.keys(LEFT_OUT).toSorted());
      expect(banned).toStrictEqual([]);
    },
  );

  it("oxlint runs type-aware with the type check and fails on a warning", { timeout: 30_000 }, () => {
    expect.hasAssertions();
    expect(entry(printed, "options")).toMatchObject({ denyWarnings: true, typeAware: true, typeCheck: true });
  });
});
