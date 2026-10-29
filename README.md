# Twitter API & X data in Convex with Xquik

[![Convex Component](https://www.convex.dev/components/badge/convex-xquik)](https://www.convex.dev/components/convex-xquik)

A Convex component for every public Xquik X API operation, signed webhooks & live event queries.

Xquik is the world's fastest and cheapest X Twitter scraper service with the most complete X data.
Xquik charges only for delivered, unique, filter-matching results and never pads rows.

<!-- trust:start -->

## Trust & usage

[![Twitter API package downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fxquik.com%2Fbadges%2Fdownloads.json)](https://xquik.com/trust#downloads)
[![Twitter scraper users on Apify](https://img.shields.io/endpoint?url=https%3A%2F%2Fxquik.com%2Fbadges%2Fapify-users.json)](https://apify.com/xquik)
[![Twitter scraper runs on Apify](https://img.shields.io/endpoint?url=https%3A%2F%2Fxquik.com%2Fbadges%2Fapify-runs.json)](https://apify.com/xquik)
[![Tweet scraper rating on Apify](https://img.shields.io/endpoint?url=https%3A%2F%2Fxquik.com%2Fbadges%2Fapify-rating.json)](https://apify.com/xquik/x-tweet-scraper/reviews)
[![Xquik Twitter API accounts](https://img.shields.io/endpoint?url=https%3A%2F%2Fxquik.com%2Fbadges%2Faccounts.json)](https://xquik.com/trust#accounts)
[![Twitter Skill installs](https://img.shields.io/endpoint?url=https%3A%2F%2Fxquik.com%2Fbadges%2Fskill-installs.json)](https://xquik.com/trust#skill-installs)
[![Xquik verified revenue on TrustMRR](https://img.shields.io/endpoint?url=https%3A%2F%2Fxquik.com%2Fbadges%2Frevenue.json)](https://trustmrr.com/startup/xquik)
[![Twitter API p99 server read time](https://img.shields.io/endpoint?url=https%3A%2F%2Fxquik.com%2Fbadges%2Frest-p99.json)](https://xquik.com/trust#speed)
[![Xquik GitHub stars](https://img.shields.io/endpoint?url=https%3A%2F%2Fxquik.com%2Fbadges%2Fgithub-stars.json)](https://github.com/Xquik-dev)

- 54,000+ downloads of Xquik's Twitter API packages on npm, PyPI, RubyGems, NuGet, Packagist & Terraform ([source](https://xquik.com/trust#downloads)) <!-- trust:downloads 54576 -->
- 10,000+ users of Xquik's Twitter scraper Actors on Apify ([source](https://apify.com/xquik)) <!-- trust:apify-users 10119 -->
- 7,000,000+ runs of Xquik's Twitter scraper Actors on Apify ([source](https://apify.com/xquik)) <!-- trust:apify-runs 7076266 -->
- 4.66 of 5 for the X Tweet Scraper from 16 Apify reviews ([source](https://apify.com/xquik/x-tweet-scraper/reviews)) <!-- trust:apify-rating 4.66 16 -->
- 4,100+ accounts on xquik.com ([source](https://xquik.com/trust#accounts)) <!-- trust:accounts 4126 -->
- 1,600+ installs of Xquik's Twitter Skills on skills.sh ([source](https://xquik.com/trust#skill-installs)) <!-- trust:skill-installs 1619 -->
- $40,000+ in revenue verified by TrustMRR ([source](https://trustmrr.com/startup/xquik)) <!-- trust:revenue 40329 -->
- 13.8 s p99 REST API server read time over 7 days, failed reads included ([source](https://xquik.com/trust#speed)) <!-- trust:rest-p99 13778 -->
- 380+ GitHub stars across Xquik's repos ([source](https://github.com/Xquik-dev)) <!-- trust:github-stars 386 -->

Checked on 2026-10-28. See each number with its date & source on [xquik.com/trust](https://xquik.com/trust) or as [JSON](https://xquik.com/trust.json).

<!-- trust:end -->

<!-- START: Include on https://convex.dev/components -->

Read the full guide at [docs.xquik.com/guides/convex](https://docs.xquik.com/guides/convex).

## What you get

- 190 typed Convex actions, 1 for each public operation in the [Xquik API reference](https://docs.xquik.com/api-reference/overview). Convex checks the arguments & the result of each call.
- A webhook receiver that checks each delivery's signature & stores each event once.
- Live queries over stored events, so your UI updates as events arrive.
- Durable jobs that retry safe calls & repeat on a schedule.
- No X developer account & no X bearer token.

## Install

```bash
npm install convex-xquik
```

Add the component in `convex/convex.config.ts`.

```ts
import { defineApp } from "convex/server";
import { v } from "convex/values";
import xquik from "convex-xquik/convex.config.js";

const app = defineApp({ env: { XQUIK_API_KEY: v.optional(v.string()) } });
app.use(xquik, { httpPrefix: "/xquik/", env: { XQUIK_API_KEY: app.env.XQUIK_API_KEY } });
export default app;
```

Set your key from the [Xquik dashboard](https://xquik.com/dashboard). Every component function answers `missing_api_key` until you set it.

```bash
npx convex env set XQUIK_API_KEY xq_your_key
```

## Call any operation

Each action takes the operation's path, query, header & body fields side by side. Convex checks them before the call.

```ts
import { v } from "convex/values";
import { components } from "./_generated/api";
import { internalAction } from "./_generated/server";

export const latest = internalAction({
  args: { username: v.string() },
  handler: async (ctx, { username }) =>
    await ctx.runAction(components.xquik.operations.searchTweets, { q: `from:${username}`, limit: 20 }),
});
```

Call `components.xquik.operations.getUser` with `{ id: "elonmusk" }` for a profile. A failed call throws a `ConvexError`. Its data has `status`, `error`, `message` & `retryAfter` in seconds for a 429.

Each result has the type & the validator of its schema in the API reference, so the `name` of a `getUser` result is a `string`. The result holds only the fields that schema lists. A JSON-LD key such as `@id` arrives as `id`. Import `OperationResult<"getUser">` from `convex-xquik` to name a result type.

## Receive webhook events

```ts
import { Xquik, eventFields } from "convex-xquik";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";

const xquik = new Xquik(components.xquik);

export const watch = internalAction({
  args: {},
  handler: async (ctx) =>
    await xquik.createWebhook(ctx, { eventTypes: ["tweet.new", "tweet.reply"], onEvent: internal.x.onEvent }),
});

export const onEvent = internalMutation({
  args: { event: eventFields },
  handler: async (ctx, { event }) => {
    console.info(event.eventType, event.streamEventId);
  },
});
```

The component creates the Xquik webhook at `https://<deployment>.convex.site/xquik/webhooks/<token>`. It keeps the signing secret in its own table. Each delivery must carry a valid `X-Xquik-Signature` & a timestamp within 5 minutes. A replayed nonce gets a 401. A retry with the same `streamEventId` is stored once, and your handler runs once per endpoint. The `webhook.test` alert gets a 200 & sets `testedAt` on the endpoint.

For a webhook made elsewhere, call `xquik.addWebhook(ctx, { secret })` from a mutation & paste the URL it returns.

## Show events live

```ts
import { paginationOptsValidator } from "convex/server";
import { components } from "./_generated/api";
import { query } from "./_generated/server";

export const events = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    if ((await ctx.auth.getUserIdentity()) === null) throw new Error("Sign in first.");
    return await ctx.runQuery(components.xquik.events.list, { paginationOpts });
  },
});
```

Use it with `usePaginatedQuery(api.x.events, {}, { initialNumItems: 20 })`. Pass `filter: { eventType }` or `filter: { monitorId }` to narrow the list.

## Schedule calls

```ts
await xquik.schedule(ctx, "listEvents", { limit: 100 }, { key: "events", everyMs: 5 * 60 * 1000 });
```

While a job with the same `key` is scheduled or running, the call returns that job's ID. A read, or a write that takes an `Idempotency-Key`, makes up to 5 attempts on a 429, a 5xx or a network error. The component fills the key for you. A result that breaks its schema fails the job without a retry. Scheduled `listEvents` jobs store their events with the webhook events. Read a job with `components.xquik.jobs.get` & stop it with `components.xquik.jobs.cancel`.

## Keep credits safe

Component functions run only from your backend. Wrap them in internal functions, or check the caller's identity & rate limit in each public function that spends credits. The [example app](https://github.com/Xquik-dev/convex-xquik/tree/main/example) keeps every credit-spending function internal.

## Test your app

```ts
import { convexTest } from "convex-test";
import xquikTest from "convex-xquik/test";

const t = convexTest(schema, modules);
xquikTest.register(t);
```

<!-- END: Include on https://convex.dev/components -->

## Develop

```bash
npm ci
npm run generate
bin/check-local
```

`example/` holds a runnable Convex app that uses the component. `npm run generate` rebuilds the operation registry from `openapi.json`. The tests prove that every public operation in `openapi.json` is an action, & that every event type gets a receiver test. See [CONTRIBUTING.md](CONTRIBUTING.md) for each check.

## Documentation

- [Xquik Convex guide](https://docs.xquik.com/guides/convex)
- [Xquik API reference](https://docs.xquik.com/api-reference/overview)
- [Webhook signature verification](https://docs.xquik.com/webhooks/verification)
- [Organization support policy](https://github.com/Xquik-dev/.github/blob/main/SUPPORT.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

Xquik is an independent third-party service. Not affiliated with X Corp. "Twitter" and "X" are trademarks of X Corp.
