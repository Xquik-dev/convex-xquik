import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v, type Infer, type Value } from "convex/values";
import { internal } from "./_generated/api.js";
import { requireApiKey } from "./access.js";
import type { Id } from "./_generated/dataModel.js";
import { env, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { pulledEvents } from "./delivery.js";
import { STREAM_MS } from "./operation.js";
import { find, matches, send } from "./request.js";
import schema, { jobStatus } from "./schema.js";
import { isRecord, type Operation } from "./shape.js";
import { json } from "./values.js";
import { store } from "./webhooks.js";

export const MAX_ATTEMPTS = 5;
export const MIN_EVERY_MS = 60_000;

export const jobDoc = schema.tables.jobs.validator.extend({ _id: v.id("jobs"), _creationTime: v.number() });

const outcome = v.union(
  v.object({ ok: v.literal(true), result: json }),
  v.object({ ok: v.literal(false), error: json, retryable: v.boolean(), retryAfterMs: v.optional(v.number()) }),
);

export type Outcome = Infer<typeof outcome>;

export interface Plan {
  readonly status: Infer<typeof jobStatus>;
  readonly delayMs: number | null;
  readonly attempts: number;
}

export function plan(job: { readonly attempts: number; readonly everyMs?: number }, result: Outcome): Plan {
  if (!result.ok && result.retryable && job.attempts + 1 < MAX_ATTEMPTS) {
    return {
      status: "scheduled",
      delayMs: result.retryAfterMs ?? 1000 * 2 ** job.attempts,
      attempts: job.attempts + 1,
    };
  }
  if (job.everyMs !== undefined) return { status: "scheduled", delayMs: job.everyMs, attempts: 0 };
  return { status: result.ok ? "succeeded" : "failed", delayMs: null, attempts: 0 };
}

function keyed(definition: Operation): boolean {
  return definition.params.some((param) => param.name === "idempotencyKey");
}

function isConvexError(error: unknown): error is ConvexError<Value> {
  return error instanceof ConvexError;
}

export function checked(id: string, definition: Operation, value: Value): Outcome {
  if (matches(definition.result, value)) return { ok: true, result: value };
  const message = `Xquik answered ${id} with a result its schema does not allow.`;
  return { ok: false, error: { status: 502, error: "unexpected_result", message }, retryable: false };
}

export function failed(definition: Operation, error: unknown): Extract<Outcome, { ok: false }> {
  const data: Value = isConvexError(error) ? error.data : { message: String(error) };
  const { status, retryAfter } = isRecord(data) ? data : {};
  const safe = definition.method === "GET" || keyed(definition);
  const transient = typeof status !== "number" || status === 429 || status >= 500;
  return {
    ok: false,
    error: data,
    retryable: safe && transient,
    ...(typeof retryAfter === "number" ? { retryAfterMs: retryAfter * 1000 } : {}),
  };
}

export const enqueue = mutation({
  args: {
    operation: v.string(),
    args: v.record(v.string(), json),
    key: v.optional(v.string()),
    everyMs: v.optional(v.number()),
    delayMs: v.optional(v.number()),
  },
  returns: v.id("jobs"),
  handler: async (ctx, { delayMs, ...job }): Promise<Id<"jobs">> => {
    requireApiKey(env.XQUIK_API_KEY);
    find(job.operation);
    const existing =
      job.key === undefined
        ? null
        : await ctx.db
            .query("jobs")
            .withIndex("by_key", (q) => q.eq("key", job.key).eq("status", "scheduled"))
            .first();
    if (existing !== null) {
      const scheduled =
        existing.scheduledId === undefined
          ? null
          : await ctx.db.system.get("_scheduled_functions", existing.scheduledId);
      if (scheduled?.state.kind === "pending" || scheduled?.state.kind === "inProgress") return existing._id;
      await ctx.db.patch("jobs", existing._id, {
        status: "failed",
        scheduledId: undefined,
        error: { message: "The job stopped before it finished, so this call replaced it." },
      });
    }
    if ((job.everyMs ?? MIN_EVERY_MS) < MIN_EVERY_MS) {
      throw new ConvexError({
        status: 400,
        error: "interval_too_short",
        message: `Set everyMs to ${String(MIN_EVERY_MS)} or more.`,
      });
    }
    const jobId = await ctx.db.insert("jobs", { ...job, status: "scheduled", attempts: 0, runs: 0 });
    const scheduledId = await ctx.scheduler.runAfter(delayMs ?? 0, internal.jobs.run, { jobId });
    await ctx.db.patch("jobs", jobId, { scheduledId });
    return jobId;
  },
});

export const load = internalQuery({
  args: { jobId: v.id("jobs") },
  returns: v.union(v.null(), jobDoc),
  handler: async (ctx, { jobId }) => await ctx.db.get("jobs", jobId),
});

export const run = internalAction({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }): Promise<null> => {
    const job = await ctx.runQuery(internal.jobs.load, { jobId });
    if (job?.status !== "scheduled") return null;
    const definition = find(job.operation);
    const args = keyed(definition) ? { idempotencyKey: `${jobId}-${String(job.runs)}`, ...job.args } : job.args;
    const result: Outcome = await send(definition, args, { apiKey: env.XQUIK_API_KEY, streamMs: STREAM_MS }).then(
      (value) => checked(job.operation, definition, value),
      (error: unknown) => failed(definition, error),
    );
    await ctx.runMutation(internal.jobs.finish, { jobId, outcome: result });
    return null;
  },
});

export const finish = internalMutation({
  args: { jobId: v.id("jobs"), outcome },
  returns: v.null(),
  handler: async (ctx, { jobId, outcome: result }): Promise<null> => {
    const job = await ctx.db.get("jobs", jobId);
    if (job?.status !== "scheduled") return null;
    if (result.ok && job.operation === "listEvents") {
      for (const event of pulledEvents(result.result)) await store(ctx, event);
    }
    const next = plan(job, result);
    const scheduledId =
      next.delayMs === null ? undefined : await ctx.scheduler.runAfter(next.delayMs, internal.jobs.run, { jobId });
    await ctx.db.patch("jobs", jobId, {
      status: next.status,
      attempts: next.attempts,
      runs: next.attempts === 0 ? job.runs + 1 : job.runs,
      scheduledId,
      ...(result.ok ? { result: result.result, error: undefined } : { error: result.error }),
    });
    return null;
  },
});

export const cancel = mutation({
  args: { jobId: v.id("jobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    requireApiKey(env.XQUIK_API_KEY);
    const scheduledId = (await ctx.db.get("jobs", jobId))?.scheduledId;
    if (scheduledId === undefined) return null;
    await ctx.scheduler.cancel(scheduledId);
    await ctx.db.patch("jobs", jobId, { status: "canceled", scheduledId: undefined });
    return null;
  },
});

export const get = query({
  args: { jobId: v.id("jobs") },
  returns: v.union(v.null(), jobDoc),
  handler: async (ctx, { jobId }) => {
    requireApiKey(env.XQUIK_API_KEY);
    return await ctx.db.get("jobs", jobId);
  },
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator, status: v.optional(jobStatus) },
  returns: paginationResultValidator(jobDoc),
  handler: async (ctx, { paginationOpts, status }) => {
    requireApiKey(env.XQUIK_API_KEY);
    const jobs = ctx.db.query("jobs");
    const ordered = status === undefined ? jobs : jobs.withIndex("by_status", (q) => q.eq("status", status));
    return await ordered.order("desc").paginate(paginationOpts);
  },
});
