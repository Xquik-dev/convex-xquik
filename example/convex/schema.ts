import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  notifications: defineTable({ eventType: v.string(), streamEventId: v.string() }),
});
