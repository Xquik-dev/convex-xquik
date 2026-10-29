import convex from "@convex-dev/eslint-plugin";
import globals from "globals";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const config = [
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    plugins: { "@convex-dev": convex },
    rules: Object.fromEntries(Object.keys(convex.rules).map((name) => [`@convex-dev/${name}`, "error"])),
  },
  {
    rules: {
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
];

export default config;
