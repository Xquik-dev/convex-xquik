import { api, components, internal } from "#example/convex/_generated/api.js";
import { assert, describe, expect, it, vi } from "vitest";
import { rejection, SECRET, stubFetch } from "./helpers.js";
import xquikTest, { register } from "#src/test.ts";
import type { Auth } from "convex/server";
import { convexTest } from "convex-test";
import { createFunctionHandle } from "convex/server";
import { requireUser } from "#example/convex/example.ts";
import schema from "#example/convex/schema.ts";
import type { TestConvex } from "convex-test";
import { Xquik } from "#src/client.ts";

const MAX_ROWS = 5;

const exampleModules = import.meta.glob("#example/convex/**/*.ts");
const componentFiles = import.meta.glob<Record<string, unknown>>("#src/component/*.ts");

const FUNCTION_FLAGS = ["isQuery", "isMutation", "isAction", "isHttp", "isRouter", "isCrons"];
const FIRST_PAGE = { cursor: null, numItems: 10 };
const unauthenticated = { error: "unauthenticated", message: "Sign in first.", status: 401 };
const DRAFT = { createdAt: "2026-10-28T19:00:00Z", id: "77", text: "hi", updatedAt: "2026-10-28T19:00:00Z" };
const BAD_PROFILES = [{ id: "1" }, { id: "1", name: 5, username: "NASA" }, "NASA", null];
const PULLED_EVENT = {
  data: { id: "1" },
  id: "9001",
  monitorId: "10",
  monitorType: "account",
  occurredAt: "2026-10-28T19:00:00.000Z",
  type: "tweet.new",
};

function exampleTest(): TestConvex<typeof schema> {
  vi.stubEnv("XQUIK_API_KEY", "xq_test");
  vi.stubEnv("CONVEX_SITE_URL", "https://happy-otter-123.convex.site/xquik");
  const backend = convexTest(schema, exampleModules);
  register(backend);
  return backend;
}

async function withFakeTimers<Result>(run: () => Promise<Result>): Promise<Result> {
  vi.useFakeTimers();
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

function isConvexFunction(value: unknown): boolean {
  return FUNCTION_FLAGS.some((flag) => Reflect.get(new Object(value), flag) === true);
}

async function modulesWithFunctions(): Promise<string[]> {
  const loaded = await Promise.all(
    Object.entries(componentFiles).map(async ([path, load]) => ({ exported: await load(), path })),
  );
  return loaded
    .filter(({ exported }) => Object.values(exported).some((value) => isConvexFunction(value)))
    .map(({ path }) => path.replace(/^.*\/component\//u, "./component/"))
    .toSorted();
}

describe("the example app's access checks", () => {
  it("refuses callers who are not signed in", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = exampleTest();
    await expect(rejection(backend.query(api.example.events, { paginationOpts: FIRST_PAGE }))).resolves.toStrictEqual(
      unauthenticated,
    );
  });

  it("requireUser returns the signed-in subject", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const identity = { issuer: "https://convex.test", subject: "user1", tokenIdentifier: "https://convex.test|user1" };
    const signedIn = vi.fn<Auth["getUserIdentity"]>().mockResolvedValue(identity);
    const signedOut = vi.fn<Auth["getUserIdentity"]>().mockResolvedValue(null);
    await expect(requireUser({ auth: { getUserIdentity: signedIn } })).resolves.toBe("user1");
    await expect(rejection(requireUser({ auth: { getUserIdentity: signedOut } }))).resolves.toStrictEqual(
      unauthenticated,
    );
  });
});

describe("the example app's scheduled pull", () => {
  it("keeps 1 scheduled pull however often it runs", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = exampleTest();
    const [first, second] = await withFakeTimers(async () => [
      await backend.mutation(internal.example.pull, {}),
      await backend.mutation(internal.example.pull, {}),
    ]);
    const jobs = await backend.query(components.xquik.jobs.list, { paginationOpts: FIRST_PAGE });
    expect(second).toBe(first);
    expect(jobs.page).toMatchObject([{ _id: first, everyMs: 300_000, key: "events" }]);
  });

  it("shows pulled events in the live query", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = exampleTest().withIdentity({ subject: "user1" });
    stubFetch(() => Response.json({ events: [PULLED_EVENT], hasMore: false }));
    const { job, page } = await withFakeTimers(async () => {
      const jobId = await backend.mutation(internal.example.pull, {});
      const scheduled = await backend.query(components.xquik.jobs.get, { jobId });
      vi.runOnlyPendingTimers();
      await backend.finishInProgressScheduledFunctions();
      return { job: scheduled, page: await backend.query(api.example.events, { paginationOpts: FIRST_PAGE }) };
    });
    expect(job).toMatchObject({ args: { limit: 100 }, everyMs: 300_000, operation: "listEvents" });
    expect(page.page.map((row) => row.streamEventId)).toStrictEqual(["9001"]);
  });
});

describe("the example app's operations", () => {
  it("reads a profile through the component", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = exampleTest().withIdentity({ subject: "user1" });
    const profile = { followers: 9, id: "44196397", name: "Elon Musk", username: "elonmusk" };
    const recorded = stubFetch(() => Response.json(profile));
    await expect(backend.action(internal.example.profile, { username: "elonmusk" })).resolves.toStrictEqual({
      followers: 9,
      name: "Elon Musk",
    });
    expect(recorded.map(({ url }) => url.pathname)).toStrictEqual(["/api/v1/x/users/elonmusk"]);
    stubFetch(() => Response.json({ id: "11348282", name: "NASA", username: "NASA" }));
    await expect(rejection(backend.action(internal.example.profile, { username: "NASA" }))).resolves.toStrictEqual({
      error: "no_follower_count",
      message: "X sent no follower count for NASA.",
      status: 502,
    });
  });

  it.each(BAD_PROFILES)("rejects the profile answer %j", { timeout: 5000 }, async (answer) => {
    expect.hasAssertions();
    const backend = exampleTest().withIdentity({ subject: "user1" });
    stubFetch(() => Response.json(answer));
    const failure = await rejection(backend.action(internal.example.profile, { username: "NASA" }));
    expect(String(failure)).toContain('Return value validation failed for action "operations:getUser"');
  });

  it("writes and deletes a draft through the component", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = exampleTest().withIdentity({ subject: "user1" });
    const recorded = stubFetch(() => Response.json(DRAFT));
    await expect(backend.action(internal.example.draft, { text: "hi" })).resolves.toBe("77");
    expect(recorded.map(({ method, url }) => `${method} ${url.pathname}`)).toStrictEqual([
      "POST /api/v1/drafts",
      "DELETE /api/v1/drafts/77",
    ]);
    stubFetch(() => Response.json([]));
    const failure = await rejection(backend.action(internal.example.draft, { text: "hi" }));
    expect(String(failure)).toContain('Return value validation failed for action "operations:createDraft"');
  });
});

describe("the example app's webhooks", () => {
  it("creates a webhook that calls the app handler for each new event", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = exampleTest().withIdentity({ subject: "user1" });
    const recorded = stubFetch(() => Response.json({ id: "42", secret: SECRET }));
    const { url, webhookId } = await backend.action(internal.example.watch, {});
    expect(webhookId).toBe("42");
    expect(recorded.map(({ body }): unknown => JSON.parse(body))).toStrictEqual([
      { eventTypes: ["tweet.new", "tweet.reply"], url },
    ]);
    const event = { data: null, eventType: "tweet.new", occurredAt: 1, streamEventId: "9001" };
    await expect(backend.mutation(internal.example.onEvent, { event })).resolves.toBeNull();
    const rows = await backend.run(async (ctx) => await ctx.db.query("notifications").take(MAX_ROWS));
    expect(rows.map(({ eventType, streamEventId }) => [streamEventId, eventType])).toStrictEqual([
      ["9001", "tweet.new"],
    ]);
  });
});

describe("the Xquik client's webhooks", () => {
  it("adds webhooks with and without an app handler", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = exampleTest();
    const xquik = new Xquik(components.xquik);
    const onEvent = await backend.run(async () => await createFunctionHandle(internal.example.onEvent));
    const added = await backend.mutation(async (ctx) => {
      const sent = vi.spyOn(ctx, "runMutation");
      const withHandler = await xquik.addWebhook(ctx, { onEvent: internal.example.onEvent, secret: SECRET });
      const withoutHandler = await xquik.addWebhook(ctx, { secret: SECRET });
      const calls = sent.mock.calls.map((call): unknown => call[1]);
      return { sent: JSON.stringify(calls), urls: [withHandler.url, withoutHandler.url] };
    });
    expect(added.urls[0]).not.toBe(added.urls[1]);
    expect(JSON.parse(added.sent)).toStrictEqual([{ onEvent, secret: SECRET }, { secret: SECRET }]);
  });

  it("creates webhooks with and without an app handler", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = exampleTest();
    const xquik = new Xquik(components.xquik);
    const onEvent = await backend.run(async () => await createFunctionHandle(internal.example.onEvent));
    stubFetch(() => Response.json({ id: "43", secret: SECRET }));
    const created = await backend.action(async (ctx) => {
      const sent = vi.spyOn(ctx, "runAction");
      const withHandler = await xquik.createWebhook(ctx, {
        eventTypes: ["post.edited"],
        onEvent: internal.example.onEvent,
      });
      const withoutHandler = await xquik.createWebhook(ctx, { eventTypes: ["post.edited"] });
      const calls = sent.mock.calls.map((call): unknown => call[1]);
      return { ids: [withHandler.webhookId, withoutHandler.webhookId], sent: JSON.stringify(calls) };
    });
    expect(created.ids).toStrictEqual(["43", "43"]);
    expect(JSON.parse(created.sent)).toStrictEqual([
      { eventTypes: ["post.edited"], onEvent },
      { eventTypes: ["post.edited"] },
    ]);
  });
});

describe("the example app config", () => {
  it("mounts the component under /xquik/ with the app's API key", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    vi.doMock<{ default: unknown }>(import("xquik-convex/convex.config.js"), () => ({
      default: { componentDefinitionPath: "xquik", defaultName: "xquik" },
    }));
    const { default: app } = await import("#example/convex/convex.config.ts");
    vi.doUnmock("xquik-convex/convex.config.js");
    const analyze: unknown = Reflect.get(app, "export");
    assert(typeof analyze === "function");
    const exported: unknown = Reflect.apply(analyze, app, []);
    expect(exported).toMatchObject({
      childComponents: [{ env: [["XQUIK_API_KEY", { name: "XQUIK_API_KEY", type: "envVar" }]], name: "xquik" }],
      httpMounts: { "/xquik/": "_reference/childComponent/xquik" },
    });
  });
});

describe("the xquik-convex/test helper", () => {
  it("registers every component module that defines Convex functions", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const registered = Object.keys(xquikTest.modules).filter((key) => !key.includes("_generated"));
    await expect(modulesWithFunctions()).resolves.toStrictEqual(registered.toSorted());
  });

  it.each(Object.entries(xquikTest.modules))("loads the module behind %s", { timeout: 5000 }, async (path, load) => {
    expect.hasAssertions();
    const actual: unknown = await import(
      new URL(path.replace("./", "../src/").replace(/\.ts$/u, ".js"), import.meta.url).href
    );
    await expect(load()).resolves.toBe(actual);
  });
});
