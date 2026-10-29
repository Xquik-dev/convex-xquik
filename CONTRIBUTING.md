# Contribute

Run all commands from the repository root. Run `bin/check-local` before you open a pull request.

```bash
bin/check-local
```

`bin/check-local` runs every check in this order. It stops at the first failure and says what to fix.

1. `npm ci` installs the locked dependencies.
2. `git grep` bans each pattern in `lint/banned-patterns.txt` in every file. The list covers every suppression comment, exclusion key, rule switched off and skipped test. The step also fails on any `.*ignore` file other than `.gitignore`, since lychee and Prettier read those whatever their flags say.
3. shellcheck lints every shell script with every optional check turned on. It finds each script by its `.sh` or `.bash` name or its shebang.
4. ast-grep runs `lint/rules/no-code-comments.yml` over every TypeScript and JavaScript file, after the cases in `lint/rule-tests` pass. A comment stays only with an `https` link to the page that proves it, or right above such a linked comment. SPDX tags, `/// <reference` lines and `PURE` or `NO_SIDE_EFFECTS` annotations stay too.
5. REUSE 6.2.0 checks that every file has a license and a copyright.
6. gitleaks scans every commit on every ref for secrets, archives included. It reads only its default rules and ignores inline allow comments.
7. lychee checks every relative link, anchor and code link in the Markdown files offline, with an empty configuration.
8. Vale checks the prose and spelling of the Markdown files. Any alert fails, suggestions included. `.vale/config/vocabularies/Xquik/accept.txt` lists the words its dictionary lacks.
9. The Convex CLI generates the component and example code on a local deployment.
10. `npm run generate` must leave `src/component/registry.json` and `src/component/operations.ts` unchanged. The generator writes both files in the Prettier format.
11. Prettier checks the format of every TypeScript, JavaScript, Markdown, JSON and YAML file.
12. `tsc` checks the types with strict options and `moduleDetection` `force`. It also checks the JavaScript configuration files.
13. ESLint runs the strict type-checked rules and every Convex rule on every file. ESLint bans `any`, type assertions and non-null assertions. Each public component function calls `requireApiKey` first, so it throws `missing_api_key` until the deployment sets `XQUIK_API_KEY`.
14. oxlint runs type-aware on every file, with every rule of its 13 plugins at `error`. `import/no-nodejs-modules` bans Node built-in imports.
15. The lint settings step fails when a file runs one of the 11 Convex rules below `error`. It also fails when oxlint runs a rule of its 13 plugins below `error`, or when a rule name matches the ban list. `lint/left-out-rules.json` names each exempt rule with the reason a failing proof gave. Each rule an exempt rule clashes with must run at `error`.
16. type-coverage needs every value of every tracked file typed without `any`.
17. `npm audit` checks the dependencies, and `npm audit signatures` checks their registry signatures.
18. Vitest runs every test, and a skipped test or a test marked to do later fails the step. The tests must run every line, branch, function and statement of every tracked source file in `src`, `scripts` and `example`, which `npm test` lists with `git ls-files`.
19. fallow fails on a function with more than 20 branches, a cognitive complexity over 15 or a CRAP score of 30 or more, its default. It computes CRAP from the coverage that step 18 writes. It also fails on any duplicated block and on an unused file, export or dependency. `.fallowrc.json` names the modules that hold Convex functions as entry points.
20. Stryker must kill every mutant of the same files, with the TypeScript checker on.
21. `npm pack` must hold the files that apps import.
22. publint finds no error, warning or suggestion in the package, and Are the Types Wrong resolves every export for ESM apps and build tools.
23. CodeQL runs its security-extended queries over the tracked files.

Fix what a check finds. Never suppress a finding or narrow a check.

The checks need Node, npm, jq, curl, uv and CodeQL on your PATH. They download the pinned ast-grep, shellcheck, gitleaks, lychee and Vale from `tools.json` and check each download's SHA-256.

## Update the operations

Replace `openapi.json` with the latest `https://xquik.com/openapi.json`. Then run `npm run generate` and commit the registry and operations module it writes.

## Release a version

1. Raise `version` in `package.json` and `package-lock.json`, and put its changes under a `## <version>` heading in `CHANGELOG.md`.
2. Merge that change to `main`, then run the dry run from a clean `main`. It runs `bin/check-local`, packs the package, lists its files and runs `npm publish --dry-run`.

   ```bash
   bin/release-local --dry-run
   ```

3. Name the Keychain item that holds an npm token that can publish `xquik-convex`, then release.

   ```bash
   NPM_KEYCHAIN_SERVICE=<service> NPM_KEYCHAIN_ACCOUNT=<account> bin/release-local
   ```

`bin/release-local` publishes the tarball it packed, tags the commit and creates the GitHub release with the tarball and the notes. A rerun repeats the checks and the pack, then skips the upload, tag or release that already happened. It stops when npm serves a different tarball for the same version. npm signs every version it serves, and `npm audit signatures` checks those signatures. Releases carry no npm provenance, because npm only makes provenance in a hosted CI run.
