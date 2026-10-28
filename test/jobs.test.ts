import { ConvexError } from "convex/values";
import type { TestConvex } from "convex-test";
import type schema from "../src/component/schema.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../src/component/_generated/api.js";
import { failed, plan } from "../src/component/jobs.js";
import { find } from "../src/component/request.js";
import { componentTest, rejection, stubFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function settle(t: TestConvex<typeof schema>): Promise<void> {
  await t.finishInProgressScheduledFunctions();
}

describe("jobs", () => {
  test("runs a scheduled read once and keeps its result", async () => {
    vi.useFakeTimers();
    const t = componentTest();
    stubFetch(() => Response.json({ id: "44196397", username: "elonmusk" }));
    const jobId = await t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "elonmusk" } });
    vi.runAllTimers();
    await settle(t);
    expect(await t.query(api.jobs.get, { jobId })).toMatchObject({
      status: "succeeded",
      runs: 1,
      attempts: 0,
      result: { username: "elonmusk" },
    });
  });

  test("repeats a pull and stores the events it reads once", async () => {
    vi.useFakeTimers();
    const t = componentTest();
    const event = {
      id: "7",
      type: "tweet.new",
      monitorId: "10",
      occurredAt: "2026-10-28T19:00:00.000Z",
      data: { id: "1" },
    };
    stubFetch(() => Response.json({ events: [event, event, { id: 8 }], hasMore: false }));
    const jobId = await t.mutation(api.jobs.enqueue, { operation: "listEvents", args: {}, everyMs: 60_000 });
    for (let run = 0; run < 2; run += 1) {
      vi.runOnlyPendingTimers();
      await settle(t);
    }
    const job = await t.query(api.jobs.get, { jobId });
    expect(job).toMatchObject({ status: "scheduled", runs: 2 });
    const page = await t.query(api.events.list, { paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page.map((row) => row.streamEventId)).toEqual(["7"]);
    await t.mutation(api.jobs.cancel, { jobId });
    expect(await t.query(api.jobs.get, { jobId })).toMatchObject({ status: "canceled" });
    await t.mutation(api.jobs.cancel, { jobId });
  });

  test("retries a failed read with backoff, then gives up", async () => {
    vi.useFakeTimers();
    const t = componentTest();
    const recorded = stubFetch(() => Response.json({ error: "busy" }, { status: 503 }));
    const jobId = await t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "elonmusk" } });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      vi.runOnlyPendingTimers();
      await settle(t);
    }
    expect(recorded).toHaveLength(5);
    expect(await t.query(api.jobs.get, { jobId })).toMatchObject({ status: "failed", runs: 1, error: { status: 503 } });
  });

  test("stores pulled events only from listEvents", async () => {
    vi.useFakeTimers();
    const t = componentTest();
    const event = { id: "7", type: "tweet.new", occurredAt: "2026-10-28T19:00:00.000Z", data: null };
    stubFetch(() => Response.json({ events: [event] }));
    const jobId = await t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "elonmusk" } });
    vi.runAllTimers();
    await settle(t);
    expect(await t.query(api.jobs.get, { jobId })).toMatchObject({ status: "succeeded" });
    const page = await t.query(api.events.list, { paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page).toEqual([]);
  });

  test("retries a write with the same Idempotency-Key", async () => {
    vi.useFakeTimers();
    const t = componentTest();
    let calls = 0;
    const recorded = stubFetch(() => {
      calls += 1;
      return calls === 1 ? Response.json({ error: "busy" }, { status: 503 }) : Response.json({ id: "1" });
    });
    const jobId = await t.mutation(api.jobs.enqueue, {
      operation: "createExtraction",
      args: { toolType: "reply_extractor", targetTweetId: "1" },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      vi.runOnlyPendingTimers();
      await settle(t);
    }
    expect(recorded.map(({ headers }) => headers.get("idempotency-key"))).toEqual([`${jobId}-0`, `${jobId}-0`]);
    expect(await t.query(api.jobs.get, { jobId })).toMatchObject({ status: "succeeded", runs: 1, attempts: 0 });
  });

  test("fills the Idempotency-Key of a write so its retries stay safe", async () => {
    vi.useFakeTimers();
    const t = componentTest();
    const recorded = stubFetch(() => Response.json({ id: "1" }));
    const jobId = await t.mutation(api.jobs.enqueue, {
      operation: "createExtraction",
      args: { toolType: "reply_extractor", targetTweetId: "1" },
      delayMs: 1000,
    });
    vi.runAllTimers();
    await settle(t);
    expect(recorded[0]?.headers.get("idempotency-key")).toBe(`${jobId}-0`);
  });

  test("keeps 1 scheduled job per key and starts a new one after a cancel", async () => {
    const t = componentTest();
    const first = await t.mutation(api.jobs.enqueue, {
      operation: "getUser",
      args: { id: "elonmusk" },
      key: "profile",
    });
    expect(await t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "NASA" }, key: "profile" })).toBe(
      first,
    );
    const other = await t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "NASA" }, key: "other" });
    await t.mutation(api.jobs.cancel, { jobId: first });
    const next = await t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "NASA" }, key: "profile" });
    expect(new Set([first, other, next]).size).toBe(3);
  });

  test("returns the running job for its key and replaces a keyed job that stopped", async () => {
    vi.useFakeTimers();
    const t = componentTest();
    const args = { operation: "getUser", args: { id: "elonmusk" }, key: "profile" };
    const first = await t.mutation(api.jobs.enqueue, args);
    const during: string[] = [];
    stubFetch(async () => {
      during.push(await t.mutation(api.jobs.enqueue, args));
      return Response.json({ id: "1" });
    });
    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();
    expect(during).toEqual([first]);
    const stuck = await t.run(async (ctx) => {
      const jobId = await ctx.db.insert("jobs", { ...args, status: "scheduled", attempts: 0, runs: 0 });
      const scheduledId = await ctx.scheduler.runAfter(0, internal.jobs.run, { jobId });
      await ctx.scheduler.cancel(scheduledId);
      await ctx.db.patch("jobs", jobId, { scheduledId });
      return jobId;
    });
    const unscheduled = await t.run(
      async (ctx) => await ctx.db.insert("jobs", { ...args, key: "other", status: "scheduled", attempts: 0, runs: 0 }),
    );
    const replaced = await t.mutation(api.jobs.enqueue, args);
    const other = await t.mutation(api.jobs.enqueue, { ...args, key: "other" });
    expect(new Set([stuck, replaced, unscheduled, other]).size).toBe(4);
    for (const jobId of [stuck, unscheduled]) {
      expect(await t.query(api.jobs.get, { jobId })).toMatchObject({
        status: "failed",
        error: { message: "The job stopped before it finished, so this call replaced it." },
      });
    }
  });

  test("lists jobs by status and refuses bad input", async () => {
    const t = componentTest();
    await t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "elonmusk" } });
    const all = await t.query(api.jobs.list, { paginationOpts: { numItems: 5, cursor: null } });
    const scheduled = await t.query(api.jobs.list, {
      paginationOpts: { numItems: 5, cursor: null },
      status: "scheduled",
    });
    const failedJobs = await t.query(api.jobs.list, {
      paginationOpts: { numItems: 5, cursor: null },
      status: "failed",
    });
    expect([all.page.length, scheduled.page.length, failedJobs.page.length]).toEqual([1, 1, 0]);
    expect(await rejection(t.mutation(api.jobs.enqueue, { operation: "nope", args: {} }))).toEqual({
      status: 404,
      error: "unknown_operation",
      message: "nope is not an Xquik operation.",
    });
    expect(await rejection(t.mutation(api.jobs.enqueue, { operation: "getUser", args: {}, everyMs: 1 }))).toEqual({
      status: 400,
      error: "interval_too_short",
      message: "Set everyMs to 60000 or more.",
    });
  });

  test("skips a job that is gone or no longer scheduled", async () => {
    const t = componentTest();
    const jobId = await t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "elonmusk" } });
    await t.mutation(api.jobs.cancel, { jobId });
    const recorded = stubFetch(() => Response.json({}));
    await t.action(internal.jobs.run, { jobId });
    await t.mutation(internal.jobs.finish, { jobId, outcome: { ok: true, result: null } });
    expect(recorded).toHaveLength(0);
    expect(await t.query(api.jobs.get, { jobId })).toMatchObject({ status: "canceled", runs: 0 });
  });

  test("does nothing for a job that no longer exists", async () => {
    vi.useFakeTimers();
    const t = componentTest();
    const jobId = await t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "elonmusk" } });
    await t.run(async (ctx) => {
      await ctx.db.delete("jobs", jobId);
    });
    const recorded = stubFetch(() => Response.json({}));
    expect(await t.action(internal.jobs.run, { jobId })).toBeNull();
    expect(await t.mutation(internal.jobs.finish, { jobId, outcome: { ok: true, result: null } })).toBeNull();
    expect(await t.mutation(api.jobs.cancel, { jobId })).toBeNull();
    expect(recorded).toHaveLength(0);
  });
});

describe("plan", () => {
  const ok = { ok: true, result: null } as const;
  const transient = { ok: false, error: null, retryable: true } as const;

  test("retries with exponential backoff or the server's delay", () => {
    expect(plan({ attempts: 0 }, transient)).toEqual({ status: "scheduled", delayMs: 1000, attempts: 1 });
    expect(plan({ attempts: 3 }, transient)).toEqual({ status: "scheduled", delayMs: 8000, attempts: 4 });
    expect(plan({ attempts: 0 }, { ...transient, retryAfterMs: 5 })).toEqual({
      status: "scheduled",
      delayMs: 5,
      attempts: 1,
    });
  });

  test("stops at the last attempt or a permanent error", () => {
    expect(plan({ attempts: 4 }, transient)).toEqual({ status: "failed", delayMs: null, attempts: 0 });
    expect(plan({ attempts: 0 }, { ...transient, retryable: false })).toEqual({
      status: "failed",
      delayMs: null,
      attempts: 0,
    });
    expect(plan({ attempts: 2 }, ok)).toEqual({ status: "succeeded", delayMs: null, attempts: 0 });
  });

  test("keeps a repeating job on its interval", () => {
    expect(plan({ attempts: 4, everyMs: 60_000 }, transient)).toEqual({
      status: "scheduled",
      delayMs: 60_000,
      attempts: 0,
    });
  });
});

describe("failed", () => {
  const read = find("getUser");
  const write = find("createDraft");

  test("retries only safe calls on 429, 5xx and network errors", () => {
    expect(failed(read, new ConvexError({ status: 429, retryAfter: 2 }))).toEqual({
      ok: false,
      error: { status: 429, retryAfter: 2 },
      retryable: true,
      retryAfterMs: 2000,
    });
    expect(failed(read, new ConvexError({ status: 500 })).retryable).toBe(true);
    expect(failed(read, new ConvexError({ status: 404 })).retryable).toBe(false);
    expect(failed(read, new TypeError("fetch failed"))).toEqual({
      ok: false,
      error: { message: "TypeError: fetch failed" },
      retryable: true,
    });
    expect(failed(write, new ConvexError({ status: 503 })).retryable).toBe(false);
    expect(failed(find("deleteDraft"), new ConvexError({ status: 503 })).retryable).toBe(false);
    expect(failed(find("createExtraction"), new ConvexError({ status: 503 })).retryable).toBe(true);
    expect(failed(read, new ConvexError("plain")).retryable).toBe(true);
  });
});
