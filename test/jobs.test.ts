import { api, internal } from "#src/component/_generated/api.ts";
import { componentTest, stubFetch } from "./helpers.js";
import { describe, expect, it, vi } from "vitest";
import { none } from "#src/component/shape.ts";

const NO_DELAY_MS = 0;
const NO_REQUESTS = 0;
const ONE_REQUEST = 1;
const ALL_ATTEMPTS = 5;
const THREE_JOBS = 3;
const FOUR_JOBS = 4;
const PAGE = { cursor: none, numItems: 10 };
const KEYED = { args: { id: "elonmusk" }, key: "profile", operation: "getUser" };
const STOPPED = {
  error: { message: "The job stopped before it finished, so this call replaced it." },
  status: "failed",
};
const EVENT = {
  data: { id: "1" },
  id: "7",
  monitorId: "10",
  monitorType: "account",
  occurredAt: "2026-10-28T19:00:00.000Z",
  type: "tweet.new",
};
const LATER = {
  data: { id: "2" },
  id: "9",
  monitorId: "10",
  monitorType: "account",
  occurredAt: "2026-10-28T20:00:00.000Z",
  type: "tweet.new",
};
const UNDATED = {
  data: { id: "1" },
  id: "8",
  monitorId: "10",
  monitorType: "account",
  occurredAt: "soon",
  type: "tweet.new",
};
const EXTRACTION = {
  id: "1",
  pollAfterMs: 1000,
  status: "pending",
  statusUrl: "https://xquik.com/api/v1/extractions/1",
  toolType: "reply_extractor",
  waitUrl: "https://xquik.com/api/v1/extractions/1/wait",
};
const WRITE = { args: { targetTweetId: "1", toolType: "reply_extractor" }, operation: "createExtraction" };

async function faked<Result>(body: () => Promise<Result>): Promise<Result> {
  vi.useFakeTimers();
  try {
    return await body();
  } finally {
    vi.useRealTimers();
  }
}

describe("job runs", () => {
  it("runs a scheduled read once and keeps its result", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const job = await faked(async () => {
      const convex = componentTest();
      stubFetch(() => Response.json({ extra: 1, id: "44196397", name: "Elon Musk", username: "elonmusk" }));
      const jobId = await convex.mutation(api.jobs.enqueue, { args: { id: "elonmusk" }, operation: "getUser" });
      vi.runAllTimers();
      await convex.finishInProgressScheduledFunctions();
      return await convex.query(api.jobs.get, { jobId });
    });
    expect(job).toMatchObject({
      attempts: 0,
      result: { id: "44196397", name: "Elon Musk", username: "elonmusk" },
      runs: 1,
      status: "succeeded",
    });
  });

  it("retries a failed read with backoff, then gives up", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const recorded = stubFetch(() => Response.json({ error: "busy" }, { status: 503 }));
    const jobId = await faked(async () => {
      const id = await convex.mutation(api.jobs.enqueue, { args: { id: "elonmusk" }, operation: "getUser" });
      await convex.finishAllScheduledFunctions(() => {
        vi.runAllTimers();
      });
      return id;
    });
    expect(recorded).toHaveLength(ALL_ATTEMPTS);
    await expect(convex.query(api.jobs.get, { jobId })).resolves.toMatchObject({
      error: { status: 503 },
      runs: 1,
      status: "failed",
    });
  });
});

describe("job results", () => {
  it("fails a job at once when its answer breaks the result schema", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const recorded = stubFetch(() => Response.json({ id: "11348282", name: 5, username: "NASA" }));
    const jobId = await faked(async () => {
      const id = await convex.mutation(api.jobs.enqueue, { args: { id: "NASA" }, operation: "getUser" });
      await convex.finishAllScheduledFunctions(() => {
        vi.runAllTimers();
      });
      return id;
    });
    expect(recorded).toHaveLength(ONE_REQUEST);
    await expect(convex.query(api.jobs.get, { jobId })).resolves.toMatchObject({
      error: {
        error: "unexpected_result",
        message: "Xquik answered getUser with a result its schema does not allow.",
        status: 502,
      },
      status: "failed",
    });
  });

  it("stores pulled events only from listEvents", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const event = { data: none, id: "7", occurredAt: "2026-10-28T19:00:00.000Z", type: "tweet.new" };
    const jobId = await faked(async () => {
      const id = await convex.mutation(api.jobs.enqueue, { args: { id: "elonmusk" }, operation: "getUser" });
      await convex.mutation(internal.jobs.finish, { jobId: id, outcome: { ok: true, result: { events: [event] } } });
      return id;
    });
    await expect(convex.query(api.jobs.get, { jobId })).resolves.toMatchObject({ status: "succeeded" });
    const page = await convex.query(api.events.list, { paginationOpts: PAGE });
    expect(page.page).toStrictEqual([]);
  });
});

describe("repeating jobs", () => {
  it("repeats a pull and stores the events it reads once", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    stubFetch(() => Response.json({ events: [EVENT, EVENT, UNDATED, LATER], hasMore: false }));
    const jobId = await faked(async () => {
      const id = await convex.mutation(api.jobs.enqueue, { args: {}, everyMs: 60_000, operation: "listEvents" });
      const tick = async (): Promise<void> => {
        vi.runOnlyPendingTimers();
        await convex.finishInProgressScheduledFunctions();
      };
      await tick();
      await tick();
      return id;
    });
    await expect(convex.query(api.jobs.get, { jobId })).resolves.toMatchObject({ runs: 2, status: "scheduled" });
    const page = await convex.query(api.events.list, { paginationOpts: PAGE });
    expect(page.page.map((row) => row.streamEventId)).toStrictEqual(["9", "7"]);
    await convex.mutation(api.jobs.cancel, { jobId });
    await expect(convex.query(api.jobs.get, { jobId })).resolves.toMatchObject({ status: "canceled" });
    await expect(convex.mutation(api.jobs.cancel, { jobId })).resolves.toBeNull();
  });
});

describe("idempotency keys", () => {
  it("retries a write with the same Idempotency-Key", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const answer = vi
      .fn<() => Response>()
      .mockReturnValueOnce(Response.json({ error: "busy" }, { status: 503 }))
      .mockReturnValueOnce(Response.json(EXTRACTION));
    const recorded = stubFetch(answer);
    const jobId = await faked(async () => {
      const id = await convex.mutation(api.jobs.enqueue, WRITE);
      await convex.finishAllScheduledFunctions(() => {
        vi.runAllTimers();
      });
      return id;
    });
    expect(recorded.map(({ headers }) => headers.get("idempotency-key"))).toStrictEqual([`${jobId}-0`, `${jobId}-0`]);
    await expect(convex.query(api.jobs.get, { jobId })).resolves.toMatchObject({
      attempts: 0,
      runs: 1,
      status: "succeeded",
    });
  });

  it("fills the Idempotency-Key of a write so its retries stay safe", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const recorded = stubFetch(() => Response.json({ id: "1" }));
    const jobId = await faked(async () => {
      const id = await convex.mutation(api.jobs.enqueue, {
        args: WRITE.args,
        delayMs: 1000,
        operation: WRITE.operation,
      });
      vi.runAllTimers();
      await convex.finishInProgressScheduledFunctions();
      return id;
    });
    expect(recorded.map(({ headers }) => headers.get("idempotency-key"))).toStrictEqual([`${jobId}-0`]);
  });
});

describe("job keys", () => {
  it("keeps 1 scheduled job per key and starts a new one after a cancel", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const first = await convex.mutation(api.jobs.enqueue, KEYED);
    await expect(
      convex.mutation(api.jobs.enqueue, { args: { id: "NASA" }, key: "profile", operation: "getUser" }),
    ).resolves.toBe(first);
    const other = await convex.mutation(api.jobs.enqueue, { args: { id: "NASA" }, key: "other", operation: "getUser" });
    await convex.mutation(api.jobs.cancel, { jobId: first });
    const next = await convex.mutation(api.jobs.enqueue, {
      args: { id: "NASA" },
      key: "profile",
      operation: "getUser",
    });
    expect(new Set([first, other, next]).size).toBe(THREE_JOBS);
  });

  it("returns the running job for its key", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const during: string[] = [];
    const first = await faked(async () => {
      const id = await convex.mutation(api.jobs.enqueue, KEYED);
      stubFetch(async () => {
        during.push(await convex.mutation(api.jobs.enqueue, KEYED));
        return Response.json({ id: "1" });
      });
      vi.runAllTimers();
      await convex.finishInProgressScheduledFunctions();
      return id;
    });
    expect(during).toStrictEqual([first]);
  });
});

describe("stopped jobs", () => {
  it("replaces a keyed job that stopped", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const ids = await faked(async () => {
      const stuck = await convex.run(async (ctx) => {
        const jobId = await ctx.db.insert("jobs", {
          args: KEYED.args,
          attempts: 0,
          key: "profile",
          operation: "getUser",
          runs: 0,
          status: "scheduled",
        });
        const scheduledId = await ctx.scheduler.runAfter(NO_DELAY_MS, internal.jobs.run, { jobId });
        await ctx.scheduler.cancel(scheduledId);
        await ctx.db.patch("jobs", jobId, { scheduledId });
        return jobId;
      });
      const unscheduled = await convex.run(
        async (ctx) =>
          await ctx.db.insert("jobs", {
            args: KEYED.args,
            attempts: 0,
            key: "other",
            operation: "getUser",
            runs: 0,
            status: "scheduled",
          }),
      );
      const replaced = await convex.mutation(api.jobs.enqueue, KEYED);
      const other = await convex.mutation(api.jobs.enqueue, { args: KEYED.args, key: "other", operation: "getUser" });
      return { other, replaced, stuck, unscheduled };
    });
    expect(new Set(Object.values(ids)).size).toBe(FOUR_JOBS);
    await expect(
      Promise.all([ids.stuck, ids.unscheduled].map(async (jobId) => await convex.query(api.jobs.get, { jobId }))),
    ).resolves.toMatchObject([STOPPED, STOPPED]);
  });
});

describe("deleted jobs", () => {
  it("does nothing for a job that no longer exists", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const jobId = await faked(async () => {
      const id = await convex.mutation(api.jobs.enqueue, { args: { id: "elonmusk" }, operation: "getUser" });
      await convex.run(async (ctx) => {
        await ctx.db.delete("jobs", id);
      });
      return id;
    });
    const recorded = stubFetch(() => Response.json({}));
    await expect(convex.action(internal.jobs.run, { jobId })).resolves.toBeNull();
    await expect(
      convex.mutation(internal.jobs.finish, { jobId, outcome: { ok: true, result: none } }),
    ).resolves.toBeNull();
    await expect(convex.mutation(api.jobs.cancel, { jobId })).resolves.toBeNull();
    expect(recorded).toHaveLength(NO_REQUESTS);
  });
});
