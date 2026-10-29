# Changelog

## 0.2.0

- Type each operation's result & check it with a validator from `openapi.json`. Export `OperationResult`.
- Fail a job without a retry when its result breaks the result schema.
- Throw `missing_api_key` from every public component function until the deployment sets `XQUIK_API_KEY`.
- Breaking. `webhooks.list` takes `paginationOpts` and returns a page from the newest endpoint, as `events.list` and `jobs.list` do.
- Add the `default` target `dist/component/_generated/component.js` to both `_generated/component` exports.
- Document the methods of the `Xquik` client class.
- Mark the README part that the Convex components directory shows.
- Publish the package as `xquik-convex` from the renamed repository Xquik-dev/xquik-convex.

## 0.1.0

- Add the Xquik Convex component with 1 typed action for each of the 190 public operations.
- Add the webhook receiver. It checks each signature, refuses replayed nonces & stores each event once.
- Add live, paginated event queries and durable jobs with retries, schedule keys & repeats.
- Add the `Xquik` client class, the `xquik-convex/test` helper & the example app.
