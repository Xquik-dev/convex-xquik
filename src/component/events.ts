import { env, query } from "./_generated/server.js";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import requireApiKey from "./access.js";
import schema from "./schema.js";
import { v } from "convex/values";

const eventDoc = schema.tables.events.validator.extend({
  _creationTime: v.number(),
  _id: v.id("events"),
});

const eventFilter = v.union(v.object({ eventType: v.string() }), v.object({ monitorId: v.string() }));

const list = query({
  args: {
    filter: v.optional(eventFilter),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { filter, paginationOpts }) => {
    requireApiKey(env.XQUIK_API_KEY);
    const events = ctx.db.query("events");
    let ordered = events.withIndex("by_occurred");
    if (typeof filter === "object" && "eventType" in filter) {
      ordered = events.withIndex("by_type", (range) => range.eq("eventType", filter.eventType));
    }
    if (typeof filter === "object" && "monitorId" in filter) {
      ordered = events.withIndex("by_monitor", (range) => range.eq("monitorId", filter.monitorId));
    }
    return await ordered.order("desc").paginate(paginationOpts);
  },
  returns: paginationResultValidator(eventDoc),
});

const get = query({
  args: { streamEventId: v.string() },
  handler: async (ctx, { streamEventId }) => {
    requireApiKey(env.XQUIK_API_KEY);
    return await ctx.db
      .query("events")
      .withIndex("by_stream_event", (range) => range.eq("streamEventId", streamEventId))
      .unique();
  },
  returns: v.union(v.null(), eventDoc),
});

export { eventDoc, get, list };
