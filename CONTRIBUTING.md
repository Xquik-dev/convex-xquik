# Contribute

Run all commands from the repository root. Run `bin/check-local` before you open a pull request.

```bash
bin/check-local
```

`bin/check-local` runs every check in this order. It stops at the first failure and says what to fix.

1. `npm ci` installs the locked dependencies.
2. `git grep` bans each pattern in `lint/banned-patterns.txt` in every file. The list covers every suppression comment, exclusion key, rule switched off and skipped test. The step also fails on any `.*ignore` file other than `.gitignore`, since lychee and Prettier read those whatever their flags say.
3. shellcheck lints every shell script with every optional check turned on. It finds each script by its `.sh` or `.bash` name or its shebang.
4. REUSE 6.2.0 checks that every file has a license and a copyright.
5. gitleaks scans every commit on every ref for secrets, archives included. It reads only its default rules and ignores inline allow comments.
6. lychee checks every relative link, anchor and code link in the Markdown files offline, with an empty configuration.
7. Vale checks the prose and spelling of the Markdown files. Any alert fails, suggestions included. `.vale/config/vocabularies/Xquik/accept.txt` lists the words its dictionary lacks.
8. The Convex CLI generates the component and example code on a local deployment.
9. `npm run generate` must leave `src/component/registry.json` and `src/component/operations.ts` unchanged.
10. Prettier checks the format of every TypeScript, JavaScript and Markdown file.
11. `tsc` checks the types with strict options and `moduleDetection` `force`. It also checks the JavaScript configuration files.
12. ESLint runs the strict type-checked rules and every Convex rule on every file, and `test/lint.test.ts` fails when a file runs a Convex rule below `error`. ESLint bans `any`, type assertions and non-null assertions. Each public component function calls `requireApiKey` first, so it throws `missing_api_key` until the deployment sets `XQUIK_API_KEY`.
13. oxlint runs type-aware on every file, with every rule of its 13 plugins at `error`. `test/lint.test.ts` fails when a rule that oxlint registers for those plugins runs below `error`, or when a rule name matches the ban list. It exempts only the rules it names, each with the reason a failing proof gave.
14. type-coverage needs every value of every tracked file typed without `any`.
15. `npm audit` checks the dependencies, and `npm audit signatures` checks their registry signatures.
16. Vitest runs every test, and a skipped test or a test marked to do later fails the step. The tests must run every line, branch, function and statement of every tracked source file.
17. Stryker must kill every mutant of every tracked source file, with the TypeScript checker on.
18. `npm pack` must hold the files that apps import.
19. publint finds no error, warning or suggestion in the package, and Are the Types Wrong resolves every export for ESM apps and build tools.
20. CodeQL runs its security-extended queries over the tracked files.

Fix what a check finds. Never suppress a finding or narrow a check.

The checks need Node, npm, jq, curl, uv and CodeQL on your PATH. They download the pinned shellcheck, gitleaks, lychee and Vale from `tools.json` and check each download's SHA-256.

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
