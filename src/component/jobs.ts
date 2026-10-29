import { env, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { failed, isLive, isScheduled, jobDoc, outcome, plan, requireInterval, runsAfter, unexpected } from "./job.js";
import { find, matches, send } from "./request.js";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { GenericId } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Outcome } from "./job.js";
import { pulledEvents } from "./delivery.js";
import requireApiKey from "./access.js";
import { store } from "./webhooks.js";
import { STREAM_MS } from "./operation.js";
import { v } from "convex/values";

const enqueue = mutation({
  args: {
    args: jobDoc.fields.args,
    delayMs: v.optional(v.number()),
    everyMs: v.optional(v.number()),
    key: v.optional(v.string()),
    operation: v.string(),
  },
  handler: async (ctx, { args, delayMs = 0, everyMs, key, operation }): Promise<GenericId<"jobs">> => {
    requireApiKey(env.XQUIK_API_KEY);
    find(operation);
    const schedule = async (): Promise<GenericId<"jobs">> => {
      requireInterval(everyMs);
      const jobId = await ctx.db.insert("jobs", { args, attempts: 0, operation, runs: 0, status: "scheduled" });
      await ctx.db.patch("jobs", jobId, {
        everyMs,
        key,
        scheduledId: await ctx.scheduler.runAfter(delayMs, internal.jobs.run, { jobId }),
      });
      return jobId;
    };
    const scheduleOnce = async (jobKey: string): Promise<GenericId<"jobs">> => {
      const existing = await ctx.db
        .query("jobs")
        .withIndex("by_key", (range) => range.eq("key", jobKey).eq("status", "scheduled"))
        .first();
      if (!existing) {
        return await schedule();
      }
      const { _id: existingId, scheduledId } = existing;
      if (typeof scheduledId === "string" && isLive(await ctx.db.system.get("_scheduled_functions", scheduledId))) {
        return existingId;
      }
      delete existing.scheduledId;
      await ctx.db.replace(
        "jobs",
        existingId,
        Object.assign(existing, {
          error: { message: "The job stopped before it finished, so this call replaced it." },
          status: "failed",
        }),
      );
      return await schedule();
    };
    if (typeof key === "string") {
      return await scheduleOnce(key);
    }
    return await schedule();
  },
  returns: v.id("jobs"),
});

const load = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => await ctx.db.get("jobs", jobId),
  returns: v.union(v.null(), jobDoc),
});

const run = internalAction({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }): Promise<void> => {
    const job = await ctx.runQuery(internal.jobs.load, { jobId });
    if (!isScheduled(job)) {
      return;
    }
    const definition = find(job.operation);
    const args = Object.fromEntries([["idempotencyKey", `${jobId}-${String(job.runs)}`], ...Object.entries(job.args)]);
    const result = await send(definition, args, { apiKey: env.XQUIK_API_KEY, streamMs: STREAM_MS }).then(
      (value): Outcome => {
        if (matches(definition.result, value)) {
          return { ok: true, result: value };
        }
        return unexpected(job.operation);
      },
      (error: unknown) => failed(definition, error),
    );
    await ctx.runMutation(internal.jobs.finish, { jobId, outcome: result });
  },
  returns: v.null(),
});

const finish = internalMutation({
  args: { jobId: v.id("jobs"), outcome },
  handler: async (ctx, { jobId, outcome: result }): Promise<void> => {
    const job = await ctx.db.get("jobs", jobId);
    if (!isScheduled(job)) {
      return;
    }
    const record = async (): Promise<void> => {
      if (!result.ok) {
        job.error = result.error;
        return;
      }
      if (job.operation === "listEvents") {
        await Promise.all(
          pulledEvents(result.result)
            .filter(
              (event, index, events) =>
                events.findIndex((first) => first.streamEventId === event.streamEventId) === index,
            )
            .map(async (event) => {
              await store(ctx, event);
            }),
        );
      }
      delete job.error;
      job.result = result.result;
    };
    const next = plan(job, result);
    await record();
    delete job.scheduledId;
    await ctx.db.replace(
      "jobs",
      jobId,
      Object.assign(job, { attempts: next.attempts, runs: runsAfter(job.runs, next), status: next.status }),
    );
    if (typeof next.delayMs === "number") {
      await ctx.db.patch("jobs", jobId, {
        scheduledId: await ctx.scheduler.runAfter(next.delayMs, internal.jobs.run, { jobId }),
      });
    }
  },
  returns: v.null(),
});

const cancel = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }): Promise<void> => {
    requireApiKey(env.XQUIK_API_KEY);
    const job = await ctx.db.get("jobs", jobId);
    if (!job) {
      return;
    }
    if (typeof job.scheduledId !== "string") {
      return;
    }
    await ctx.scheduler.cancel(job.scheduledId);
    delete job.scheduledId;
    await ctx.db.replace("jobs", jobId, Object.assign(job, { status: "canceled" }));
  },
  returns: v.null(),
});

const get = query({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) => {
    requireApiKey(env.XQUIK_API_KEY);
    return await ctx.db.get("jobs", jobId);
  },
  returns: v.union(v.null(), jobDoc),
});

const list = query({
  args: { paginationOpts: paginationOptsValidator, status: v.optional(jobDoc.fields.status) },
  handler: async (ctx, { paginationOpts, status }) => {
    requireApiKey(env.XQUIK_API_KEY);
    const jobs = ctx.db.query("jobs");
    if (typeof status !== "string") {
      return await jobs.order("desc").paginate(paginationOpts);
    }
    return await jobs
      .withIndex("by_status", (range) => range.eq("status", status))
      .order("desc")
      .paginate(paginationOpts);
  },
  returns: paginationResultValidator(jobDoc),
});

export { cancel, enqueue, finish, get, list, load, run };
