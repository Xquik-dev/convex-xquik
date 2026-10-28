# Contribute

Run all commands from the repository root. Run `bin/check-local` before you open a pull request.

```bash
bin/check-local
```

`bin/check-local` runs every check in this order. It stops at the first failure and says what to fix.

1. `npm ci` installs the locked dependencies.
2. `git grep` bans each pattern in `lint/banned-patterns.txt` in every file. The list covers every suppression comment, exclusion key and skipped test.
3. shellcheck lints `bin/check-local` with every optional check turned on.
4. REUSE 6.2.0 checks that every file has a license and a copyright.
5. gitleaks scans every commit for secrets.
6. lychee checks every relative link and anchor in the Markdown files offline.
7. Vale checks the prose of the Markdown files.
8. The Convex CLI generates the component and example code on a local deployment.
9. `npm run generate` must leave `src/component/registry.json` and `src/component/operations.ts` unchanged.
10. Prettier checks the format of every TypeScript, JavaScript and Markdown file.
11. `tsc` checks the types with strict compiler options, including the JavaScript config files.
12. ESLint runs the strict type-checked rules and every Convex rule. It bans `any`, type assertions and non-null assertions. Component functions skip the access control rule, because only the installing app can call them.
13. type-coverage needs every value of every tracked file typed without `any`.
14. `npm audit` checks the dependencies, and `npm audit signatures` checks their registry signatures.
15. Vitest runs every test. The tests must run every line, branch, function and statement of every tracked source file.
16. Stryker must kill every mutant of every tracked source file, with the TypeScript checker on.
17. `npm pack` must hold the files that apps import.
18. CodeQL runs its security-extended queries over the tracked files.

Fix what a check finds. Never suppress a finding or narrow a check.

The checks need Node, npm, jq, curl, uv and CodeQL on your PATH. They download the pinned shellcheck, gitleaks, lychee and Vale from `tools.json` and check each download's SHA-256.

## Update the operations

Replace `openapi.json` with the latest `https://xquik.com/openapi.json`. Then run `npm run generate` and commit the registry and operations module it writes.
