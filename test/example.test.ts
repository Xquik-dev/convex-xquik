import { readdirSync } from "node:fs";
import { convexTest, type TestConvex } from "convex-test";
import { createFunctionHandle } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import xquikTest from "../src/test.js";
import { Xquik } from "../src/client/index.js";
import { api, components, internal } from "../example/convex/_generated/api.js";
import { requireUser } from "../example/convex/example.js";
import schema from "../example/convex/schema.js";
import { isRecord } from "../src/component/shape.js";
import { rejection, SECRET, stubFetch } from "./helpers.js";

const modules = import.meta.glob("../example/convex/**/*.ts");

function exampleTest(): TestConvex<typeof schema> {
  vi.stubEnv("XQUIK_API_KEY", "xq_test");
  vi.stubEnv("CONVEX_SITE_URL", "https://happy-otter-123.convex.site/xquik");
  const t = convexTest(schema, modules);
  xquikTest.register(t);
  return t;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const unauthenticated = { status: 401, error: "unauthenticated", message: "Sign in first." };

describe("the example app", () => {
  test("refuses callers who are not signed in", async () => {
    const t = exampleTest();
    const paginationOpts = { numItems: 10, cursor: null };
    expect(await rejection(t.query(api.example.events, { paginationOpts }))).toEqual(unauthenticated);
  });

  test("keeps 1 scheduled pull however often it runs", async () => {
    vi.useFakeTimers();
    const t = exampleTest();
    const first = await t.mutation(internal.example.pull, {});
    expect(await t.mutation(internal.example.pull, {})).toBe(first);
    const jobs = await t.query(components.xquik.jobs.list, { paginationOpts: { numItems: 10, cursor: null } });
    expect(jobs.page.map((job) => [job._id, job.key, job.everyMs])).toEqual([[first, "events", 300_000]]);
  });

  test("requireUser returns the signed-in subject", async () => {
    const identity = { subject: "user1", issuer: "https://convex.test", tokenIdentifier: "https://convex.test|user1" };
    expect(await requireUser({ auth: { getUserIdentity: () => Promise.resolve(identity) } })).toBe("user1");
    expect(await rejection(requireUser({ auth: { getUserIdentity: () => Promise.resolve(null) } }))).toEqual(
      unauthenticated,
    );
  });

  test("reads a profile through the component", async () => {
    const t = exampleTest().withIdentity({ subject: "user1" });
    const recorded = stubFetch(() =>
      Response.json({ id: "44196397", username: "elonmusk", name: "Elon Musk", followers: 9 }),
    );
    expect(await t.action(internal.example.profile, { username: "elonmusk" })).toEqual({
      name: "Elon Musk",
      followers: 9,
    });
    expect(recorded[0]?.url.pathname).toBe("/api/v1/x/users/elonmusk");
    stubFetch(() => Response.json({ id: "11348282", username: "NASA", name: "NASA" }));
    expect(await rejection(t.action(internal.example.profile, { username: "NASA" }))).toEqual({
      status: 502,
      error: "no_follower_count",
      message: "X sent no follower count for NASA.",
    });
    for (const answer of [{ id: "1" }, { id: "1", username: "NASA", name: 5 }, "NASA", null]) {
      stubFetch(() => Response.json(answer));
      expect(String(await rejection(t.action(internal.example.profile, { username: "NASA" })))).toContain(
        'Return value validation failed for action "operations:getUser"',
      );
    }
  });

  test("writes and deletes a draft through the component", async () => {
    const t = exampleTest().withIdentity({ subject: "user1" });
    const draft = { id: "77", text: "hi", createdAt: "2026-10-28T19:00:00Z", updatedAt: "2026-10-28T19:00:00Z" };
    const recorded = stubFetch(() => Response.json(draft));
    expect(await t.action(internal.example.draft, { text: "hi" })).toBe("77");
    expect(recorded.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([
      "POST /api/v1/drafts",
      "DELETE /api/v1/drafts/77",
    ]);
    stubFetch(() => Response.json([]));
    expect(String(await rejection(t.action(internal.example.draft, { text: "hi" })))).toContain(
      'Return value validation failed for action "operations:createDraft"',
    );
  });

  test("creates a webhook that calls the app handler for each new event", async () => {
    const t = exampleTest().withIdentity({ subject: "user1" });
    const recorded = stubFetch(() => Response.json({ id: "42", secret: SECRET }));
    const { url, webhookId } = await t.action(internal.example.watch, {});
    expect(webhookId).toBe("42");
    expect(JSON.parse(recorded[0]?.body ?? "")).toEqual({ eventTypes: ["tweet.new", "tweet.reply"], url });
    const event = { streamEventId: "9001", eventType: "tweet.new", occurredAt: 1, data: null };
    expect(await t.mutation(internal.example.onEvent, { event })).toBeNull();
    const rows = await t.run(async (ctx) => await ctx.db.query("notifications").take(5));
    expect(rows.map(({ streamEventId, eventType }) => [streamEventId, eventType])).toEqual([["9001", "tweet.new"]]);
  });

  test("the client registers webhooks with and without an app handler", async () => {
    const t = exampleTest();
    const xquik = new Xquik(components.xquik);
    const onEvent = await t.run(async () => await createFunctionHandle(internal.example.onEvent));
    const added = await t.mutation(async (ctx) => {
      const sent = vi.spyOn(ctx, "runMutation");
      const urls = [
        (await xquik.addWebhook(ctx, { secret: SECRET, onEvent: internal.example.onEvent })).url,
        (await xquik.addWebhook(ctx, { secret: SECRET })).url,
      ];
      return { urls, sent: JSON.stringify(sent.mock.calls.map((call): unknown => call[1])) };
    });
    expect(added.urls[0]).not.toBe(added.urls[1]);
    expect(JSON.parse(added.sent)).toEqual([{ secret: SECRET, onEvent }, { secret: SECRET }]);
    stubFetch(() => Response.json({ id: "43", secret: SECRET }));
    const created = await t.action(async (ctx) => {
      const sent = vi.spyOn(ctx, "runAction");
      const ids = [
        (await xquik.createWebhook(ctx, { eventTypes: ["post.edited"], onEvent: internal.example.onEvent })).webhookId,
        (await xquik.createWebhook(ctx, { eventTypes: ["post.edited"] })).webhookId,
      ];
      return { ids, sent: JSON.stringify(sent.mock.calls.map((call): unknown => call[1])) };
    });
    expect(created.ids).toEqual(["43", "43"]);
    expect(JSON.parse(created.sent)).toEqual([
      { eventTypes: ["post.edited"], onEvent },
      { eventTypes: ["post.edited"] },
    ]);
  });

  test("mounts the component under /xquik/ with the app's API key", async () => {
    vi.doMock("convex-xquik/convex.config.js", () => ({
      default: { componentDefinitionPath: "xquik", defaultName: "xquik" },
    }));
    const { default: app } = await import("../example/convex/convex.config.js");
    const analyze: unknown = Reflect.get(app, "export");
    const exported: unknown = typeof analyze === "function" ? Reflect.apply(analyze, app, []) : null;
    expect(exported).toMatchObject({
      childComponents: [{ name: "xquik", env: [["XQUIK_API_KEY", { type: "envVar", name: "XQUIK_API_KEY" }]] }],
      httpMounts: { "/xquik/": "_reference/childComponent/xquik" },
    });
    vi.doUnmock("convex-xquik/convex.config.js");
  });

  test("shows pulled events in the live query", async () => {
    vi.useFakeTimers();
    const t = exampleTest().withIdentity({ subject: "user1" });
    const event = {
      id: "9001",
      type: "tweet.new",
      monitorId: "10",
      monitorType: "account",
      occurredAt: "2026-10-28T19:00:00.000Z",
      data: { id: "1" },
    };
    stubFetch(() => Response.json({ events: [event], hasMore: false }));
    const jobId = await t.mutation(internal.example.pull, {});
    expect(await t.query(components.xquik.jobs.get, { jobId })).toMatchObject({
      operation: "listEvents",
      args: { limit: 100 },
      everyMs: 300_000,
    });
    vi.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
    const page = await t.query(api.example.events, { paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page.map((row) => row.streamEventId)).toEqual(["9001"]);
  });
});

describe("the convex-xquik/test helper", () => {
  test("registers every component module that defines Convex functions", async () => {
    const folder = new URL("../src/component/", import.meta.url);
    const files = readdirSync(folder).filter((file) => file.endsWith(".ts") && file !== "convex.config.ts");
    const flags = ["isQuery", "isMutation", "isAction", "isHttp", "isRouter", "isCrons"];
    const withFunctions: string[] = [];
    for (const file of files) {
      const exported: unknown = await import(new URL(file, folder).href);
      const values = isRecord(exported) ? Object.values(exported) : [];
      const defines = values.some((value) => flags.some((flag) => Reflect.get(Object(value), flag) === true));
      if (defines) withFunctions.push(`./component/${file}`);
    }
    expect(
      Object.keys(xquikTest.modules)
        .filter((key) => !key.includes("_generated"))
        .sort(),
    ).toEqual(withFunctions.sort());
  });

  test("loads the module behind each path", async () => {
    for (const [path, load] of Object.entries(xquikTest.modules)) {
      const actual: unknown = await import(
        new URL(path.replace("./", "../src/").replace(/\.ts$/, ".js"), import.meta.url).href
      );
      expect(await load(), path).toBe(actual);
    }
  });
});
