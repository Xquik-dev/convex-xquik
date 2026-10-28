// @vitest-environment node
import { execFileSync } from "node:child_process";
import convex from "@convex-dev/eslint-plugin";
import { ESLint } from "eslint";
import { expect, test } from "vitest";
import { isList, isRecord } from "../src/component/shape.js";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.js"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter((file) => file !== "");
const rules = Object.keys(convex.rules).map((name) => `@convex-dev/${name}`);

function severity(config: unknown, rule: string): unknown {
  const all = isRecord(config) ? config["rules"] : undefined;
  const setting = isRecord(all) ? all[rule] : undefined;
  return isList(setting) ? setting[0] : setting;
}

test("every Convex rule runs at error on every tracked file", { timeout: 30_000 }, async () => {
  const eslint = new ESLint({ cwd: root });
  const weaker = await Promise.all(
    files.map(async (file) => {
      const config: unknown = await eslint.calculateConfigForFile(file);
      return { file, rules: rules.filter((rule) => severity(config, rule) !== 2) };
    }),
  );
  expect(files).toContain("src/component/events.ts");
  expect(rules).toHaveLength(11);
  expect(weaker.filter((entry) => entry.rules.length > 0)).toEqual([]);
});
