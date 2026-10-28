import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  notifications: defineTable({ streamEventId: v.string(), eventType: v.string() }),
});
