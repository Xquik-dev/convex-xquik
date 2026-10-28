import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { env, query } from "./_generated/server.js";
import { requireApiKey } from "./access.js";
import schema from "./schema.js";

export const eventDoc = schema.tables.events.validator.extend({
  _id: v.id("events"),
  _creationTime: v.number(),
});

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
    filter: v.optional(v.union(v.object({ eventType: v.string() }), v.object({ monitorId: v.string() }))),
  },
  returns: paginationResultValidator(eventDoc),
  handler: async (ctx, { paginationOpts, filter }) => {
    requireApiKey(env.XQUIK_API_KEY);
    const events = ctx.db.query("events");
    const ordered =
      filter === undefined
        ? events.withIndex("by_occurred")
        : "eventType" in filter
          ? events.withIndex("by_type", (q) => q.eq("eventType", filter.eventType))
          : events.withIndex("by_monitor", (q) => q.eq("monitorId", filter.monitorId));
    return await ordered.order("desc").paginate(paginationOpts);
  },
});

export const get = query({
  args: { streamEventId: v.string() },
  returns: v.union(v.null(), eventDoc),
  handler: async (ctx, { streamEventId }) => {
    requireApiKey(env.XQUIK_API_KEY);
    return await ctx.db
      .query("events")
      .withIndex("by_stream_event", (q) => q.eq("streamEventId", streamEventId))
      .unique();
  },
});
