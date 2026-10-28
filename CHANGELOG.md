# Changelog

## Unreleased

- Type each operation's result & check it with a validator from `openapi.json`. Export `OperationResult`.

## 0.1.0

- Add the Xquik Convex component with 1 typed action for each of the 190 public operations.
- Add the webhook receiver. It checks each signature, refuses replayed nonces & stores each event once.
- Add live, paginated event queries and durable jobs with retries, schedule keys & repeats.
- Add the `Xquik` client class, the `convex-xquik/test` helper & the example app.
