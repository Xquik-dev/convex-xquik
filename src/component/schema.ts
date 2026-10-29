import { defineSchema, defineTable } from "convex/server";
import { eventFields, json } from "./values.js";
import { v } from "convex/values";

const jobStatus = v.union(v.literal("scheduled"), v.literal("succeeded"), v.literal("failed"), v.literal("canceled"));

const endpointFields = {
  onEvent: v.optional(v.string()),
  secret: v.string(),
  testedAt: v.optional(v.number()),
  token: v.string(),
  webhookId: v.optional(v.string()),
};

const jobFields = {
  args: v.record(v.string(), json),
  attempts: v.number(),
  error: v.optional(json),
  everyMs: v.optional(v.number()),
  key: v.optional(v.string()),
  operation: v.string(),
  result: v.optional(json),
  runs: v.number(),
  scheduledId: v.optional(v.id("_scheduled_functions")),
  status: jobStatus,
};

export default defineSchema({
  endpoints: defineTable(endpointFields).index("by_token", ["token"]),
  events: defineTable(eventFields)
    .index("by_stream_event", ["streamEventId"])
    .index("by_occurred", ["occurredAt"])
    .index("by_type", ["eventType", "occurredAt"])
    .index("by_monitor", ["monitorId", "occurredAt"]),
  jobs: defineTable(jobFields).index("by_status", ["status"]).index("by_key", ["key", "status"]),
  nonces: defineTable({
    endpointId: v.id("endpoints"),
    expiresAt: v.number(),
    nonce: v.string(),
  })
    .index("by_nonce", ["endpointId", "nonce"])
    .index("by_expiry", ["expiresAt"]),
  receipts: defineTable({
    endpointId: v.id("endpoints"),
    streamEventId: v.string(),
  }).index("by_event", ["endpointId", "streamEventId"]),
});

export { jobStatus };
