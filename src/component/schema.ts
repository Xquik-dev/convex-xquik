import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { eventFields, json } from "./values.js";

export const jobStatus = v.union(
  v.literal("scheduled"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
);

export default defineSchema({
  endpoints: defineTable({
    token: v.string(),
    secret: v.string(),
    webhookId: v.optional(v.string()),
    onEvent: v.optional(v.string()),
    testedAt: v.optional(v.number()),
  }).index("by_token", ["token"]),
  nonces: defineTable({
    endpointId: v.id("endpoints"),
    nonce: v.string(),
    expiresAt: v.number(),
  })
    .index("by_nonce", ["endpointId", "nonce"])
    .index("by_expiry", ["expiresAt"]),
  receipts: defineTable({
    endpointId: v.id("endpoints"),
    streamEventId: v.string(),
  }).index("by_event", ["endpointId", "streamEventId"]),
  events: defineTable(eventFields)
    .index("by_stream_event", ["streamEventId"])
    .index("by_occurred", ["occurredAt"])
    .index("by_type", ["eventType", "occurredAt"])
    .index("by_monitor", ["monitorId", "occurredAt"]),
  jobs: defineTable({
    key: v.optional(v.string()),
    operation: v.string(),
    args: v.record(v.string(), json),
    everyMs: v.optional(v.number()),
    status: jobStatus,
    attempts: v.number(),
    runs: v.number(),
    scheduledId: v.optional(v.id("_scheduled_functions")),
    result: v.optional(json),
    error: v.optional(json),
  })
    .index("by_status", ["status"])
    .index("by_key", ["key", "status"]),
});
