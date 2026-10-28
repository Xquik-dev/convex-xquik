import js from "@eslint/js";
import convex from "@convex-dev/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

const convexRules = Object.fromEntries(Object.keys(convex.rules).map((name) => [`@convex-dev/${name}`, "error"]));

/** @type {import("@typescript-eslint/utils").TSESLint.FlatConfig.ConfigArray} */
const config = [
  {
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    plugins: { "@convex-dev": convex },
    rules: {
      ...convexRules,
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    // Only the installing app can call component functions, and components have no ctx.auth.
    // https://docs.convex.dev/components/authoring#the-component-api
    files: ["src/component/**"],
    rules: { "@convex-dev/require-access-control": "off" },
  },
];

export default config;
