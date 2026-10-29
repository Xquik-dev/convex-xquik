import { api, internal } from "#src/component/_generated/api.ts";
import { componentTest, rejection, stubFetch } from "./helpers.js";
import { describe, expect, it } from "vitest";
import { failed, isLive, plan } from "#src/component/job.ts";
import { ConvexError } from "convex/values";
import { find } from "#src/component/request.ts";
import { none } from "#src/component/shape.ts";
import type { Outcome } from "#src/component/job.ts";

const NO_JOBS = 0;
const ONE_JOB = 1;
const NO_REQUESTS = 0;
const PAGE = { cursor: none, numItems: 5 };

describe("job queries", () => {
  it("lists jobs by status and refuses bad input", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    await convex.mutation(api.jobs.enqueue, { args: { id: "elonmusk" }, operation: "getUser" });
    const all = await convex.query(api.jobs.list, { paginationOpts: PAGE });
    const scheduled = await convex.query(api.jobs.list, { paginationOpts: PAGE, status: "scheduled" });
    const failedJobs = await convex.query(api.jobs.list, { paginationOpts: PAGE, status: "failed" });
    expect([all.page.length, scheduled.page.length, failedJobs.page.length]).toStrictEqual([ONE_JOB, ONE_JOB, NO_JOBS]);
    await expect(rejection(convex.mutation(api.jobs.enqueue, { args: {}, operation: "nope" }))).resolves.toStrictEqual({
      error: "unknown_operation",
      message: "nope is not an Xquik operation.",
      status: 404,
    });
    await expect(
      rejection(convex.mutation(api.jobs.enqueue, { args: {}, everyMs: 1, operation: "getUser" })),
    ).resolves.toStrictEqual({
      error: "interval_too_short",
      message: "Set everyMs to 60000 or more.",
      status: 400,
    });
  });

  it("skips a job that is gone or no longer scheduled", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const jobId = await convex.mutation(api.jobs.enqueue, { args: { id: "elonmusk" }, operation: "getUser" });
    await convex.mutation(api.jobs.cancel, { jobId });
    const recorded = stubFetch(() => Response.json({}));
    await convex.action(internal.jobs.run, { jobId });
    await convex.mutation(internal.jobs.finish, { jobId, outcome: { ok: true, result: none } });
    expect(recorded).toHaveLength(NO_REQUESTS);
    await expect(convex.query(api.jobs.get, { jobId })).resolves.toMatchObject({ runs: 0, status: "canceled" });
    await expect(convex.query(api.jobs.get, { jobId })).resolves.not.toHaveProperty("scheduledId");
  });
});

describe(plan, () => {
  const ok: Outcome = { ok: true, result: none };
  const transient: Outcome = { error: none, ok: false, retryable: true };
  const delayed: Outcome = { error: none, ok: false, retryAfterMs: 5, retryable: true };
  const permanent: Outcome = { error: none, ok: false, retryable: false };

  it("retries with exponential backoff or the server's delay", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    expect(plan({ attempts: 0 }, transient)).toStrictEqual({ attempts: 1, delayMs: 1000, status: "scheduled" });
    expect(plan({ attempts: 3 }, transient)).toStrictEqual({ attempts: 4, delayMs: 8000, status: "scheduled" });
    expect(plan({ attempts: 0 }, delayed)).toStrictEqual({ attempts: 1, delayMs: 5, status: "scheduled" });
  });

  it("stops at the last attempt or a permanent error", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    expect(plan({ attempts: 4 }, transient)).toStrictEqual({ attempts: 0, status: "failed" });
    expect(plan({ attempts: 0 }, permanent)).toStrictEqual({ attempts: 0, status: "failed" });
    expect(plan({ attempts: 2 }, ok)).toStrictEqual({ attempts: 0, status: "succeeded" });
  });

  it("keeps a repeating job on its interval", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    expect(plan({ attempts: 4, everyMs: 60_000 }, transient)).toStrictEqual({
      attempts: 0,
      delayMs: 60_000,
      status: "scheduled",
    });
  });
});

describe(failed, () => {
  const read = find("getUser");
  const write = find("createDraft");

  it("retries only safe calls on 429, 5xx and network errors", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    expect(failed(read, new ConvexError({ retryAfter: 2, status: 429 }))).toStrictEqual({
      error: { retryAfter: 2, status: 429 },
      ok: false,
      retryAfterMs: 2000,
      retryable: true,
    });
    expect(failed(read, new TypeError("fetch failed"))).toStrictEqual({
      error: { message: "TypeError: fetch failed" },
      ok: false,
      retryable: true,
    });
    const errors = [new ConvexError({ status: 500 }), new ConvexError({ status: 404 }), new ConvexError("plain")];
    expect(errors.map((error) => failed(read, error).retryable)).toStrictEqual([true, false, true]);
  });

  it("retries a write only when it carries an Idempotency-Key", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const operations = [write, find("deleteDraft"), find("createExtraction")];
    expect(operations.map((operation) => failed(operation, new ConvexError({ status: 503 })).retryable)).toStrictEqual([
      false,
      false,
      true,
    ]);
  });

  it("treats an error that carries no data as transient", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    expect(failed(read, new ConvexError(none))).toStrictEqual({ error: none, ok: false, retryable: true });
  });
});

describe(isLive, () => {
  it("counts a run as live only while its scheduled function waits or runs", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const runs = [
      { state: { kind: "pending" } },
      { state: { kind: "inProgress" } },
      { state: { kind: "canceled" } },
      none,
    ];
    expect(runs.map((scheduled) => isLive(scheduled))).toStrictEqual([true, true, false, false]);
  });
});
