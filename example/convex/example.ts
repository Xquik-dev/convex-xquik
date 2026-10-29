import { paginationOptsValidator, paginationResultValidator, type Auth, type PaginationResult } from "convex/server";
import { ConvexError, v } from "convex/values";
import { eventDoc, eventFields, Xquik, type EventDoc } from "xquik-convex";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation, query } from "./_generated/server.js";

const xquik = new Xquik(components.xquik);

export async function requireUser(ctx: { readonly auth: Auth }): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new ConvexError({ status: 401, error: "unauthenticated", message: "Sign in first." });
  return identity.subject;
}

export const profile = internalAction({
  args: { username: v.string() },
  returns: v.object({ name: v.string(), followers: v.number() }),
  handler: async (ctx, { username }) => {
    const user = await ctx.runAction(components.xquik.operations.getUser, { id: username });
    if (user.followers === undefined) {
      throw new ConvexError({
        status: 502,
        error: "no_follower_count",
        message: `X sent no follower count for ${username}.`,
      });
    }
    return { name: user.name, followers: user.followers };
  },
});

export const draft = internalAction({
  args: { text: v.string() },
  returns: v.string(),
  handler: async (ctx, { text }) => {
    const created = await ctx.runAction(components.xquik.operations.createDraft, { text });
    await ctx.runAction(components.xquik.operations.deleteDraft, { id: created.id });
    return created.id;
  },
});

export const watch = internalAction({
  args: {},
  returns: v.object({ endpointId: v.string(), url: v.string(), webhookId: v.string() }),
  handler: async (ctx): Promise<{ endpointId: string; url: string; webhookId: string }> =>
    await xquik.createWebhook(ctx, { eventTypes: ["tweet.new", "tweet.reply"], onEvent: internal.example.onEvent }),
});

export const onEvent = internalMutation({
  args: { event: eventFields },
  returns: v.null(),
  handler: async (ctx, { event }) => {
    await ctx.db.insert("notifications", { streamEventId: event.streamEventId, eventType: event.eventType });
    return null;
  },
});

export const pull = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) =>
    await xquik.schedule(ctx, "listEvents", { limit: 100 }, { key: "events", everyMs: 5 * 60 * 1000 }),
});

export const events = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(eventDoc),
  handler: async (ctx, { paginationOpts }): Promise<PaginationResult<EventDoc>> => {
    await requireUser(ctx);
    return await ctx.runQuery(components.xquik.events.list, { paginationOpts });
  },
});
