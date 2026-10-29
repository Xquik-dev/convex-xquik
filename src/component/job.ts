import { ConvexError, v } from "convex/values";
import type { Infer, Value } from "convex/values";
import { isRecord } from "./shape.js";
import type { jobStatus } from "./schema.js";
import { json } from "./values.js";
import type { Operation } from "./shape.js";
import schema from "./schema.js";

const MAX_ATTEMPTS = 5;
const MIN_EVERY_MS = 60_000;
const ONE_ATTEMPT = 1;
const ONE_RUN = 1;
const NO_RETRIES = 0;
const FIRST_DELAY_MS = 1000;
const BACKOFF = 2;
const MS_PER_SECOND = 1000;
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;
const LIVE = new Set(["inProgress", "pending"]);

const jobDoc = schema.tables.jobs.validator.extend({ _creationTime: v.number(), _id: v.id("jobs") });

const success = v.object({ ok: v.literal(true), result: json });
const failure = v.object({
  error: json,
  ok: v.literal(false),
  retryAfterMs: v.optional(v.number()),
  retryable: v.boolean(),
});
const outcome = v.union(success, failure);

type Outcome = Infer<typeof outcome>;
type Failure = Infer<typeof failure>;
type Attempt =
  { readonly ok: true } | { readonly ok: false; readonly retryAfterMs?: number; readonly retryable: boolean };

interface Plan {
  readonly status: Infer<typeof jobStatus>;
  readonly delayMs?: number;
  readonly attempts: number;
}

function plan(job: { readonly attempts: number; readonly everyMs?: number }, result: Attempt): Plan {
  if (!result.ok && result.retryable && job.attempts + ONE_ATTEMPT < MAX_ATTEMPTS) {
    return {
      attempts: job.attempts + ONE_ATTEMPT,
      delayMs: result.retryAfterMs ?? FIRST_DELAY_MS * BACKOFF ** job.attempts,
      status: "scheduled",
    };
  }
  if (typeof job.everyMs === "number") {
    return { attempts: 0, delayMs: job.everyMs, status: "scheduled" };
  }
  if (result.ok) {
    return { attempts: 0, status: "succeeded" };
  }
  return { attempts: 0, status: "failed" };
}

function runsAfter(runs: number, next: Plan): number {
  if (next.attempts === NO_RETRIES) {
    return runs + ONE_RUN;
  }
  return runs;
}

function isScheduled(job: { readonly status: string } | null): job is { readonly status: "scheduled" } {
  if (!job) {
    return false;
  }
  return job.status === "scheduled";
}

function isLive(scheduled: { readonly state: { readonly kind: string } } | null): boolean {
  if (!scheduled) {
    return false;
  }
  return LIVE.has(scheduled.state.kind);
}

function requireInterval(everyMs: number | undefined): void {
  if ((everyMs ?? MIN_EVERY_MS) < MIN_EVERY_MS) {
    throw new ConvexError({
      error: "interval_too_short",
      message: `Set everyMs to ${String(MIN_EVERY_MS)} or more.`,
      status: 400,
    });
  }
}

function keyed(definition: Operation): boolean {
  return definition.params.some((param) => param.name === "idempotencyKey");
}

function isConvexError(error: unknown): error is ConvexError<Value> {
  return error instanceof ConvexError;
}

function errorData(error: unknown): Value {
  if (isConvexError(error)) {
    return error.data;
  }
  return { message: String(error) };
}

function asRecord(data: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(data)) {
    return data;
  }
  return {};
}

function unexpected(id: string): Failure {
  const message = `Xquik answered ${id} with a result its schema does not allow.`;
  return { error: { error: "unexpected_result", message, status: 502 }, ok: false, retryable: false };
}

function failed(definition: Operation, error: unknown): Failure {
  const data = errorData(error);
  const { retryAfter, status } = asRecord(data);
  const safe = definition.method === "GET" || keyed(definition);
  const transient = typeof status !== "number" || status === TOO_MANY_REQUESTS || status >= SERVER_ERROR;
  const retryable = safe && transient;
  if (typeof retryAfter === "number") {
    return { error: data, ok: false, retryAfterMs: retryAfter * MS_PER_SECOND, retryable };
  }
  return { error: data, ok: false, retryable };
}

export { failed, isLive, isScheduled, jobDoc, outcome, plan, requireInterval, runsAfter, unexpected };
export type { Attempt, Failure, Outcome, Plan };
