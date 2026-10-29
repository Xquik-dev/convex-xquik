import type { Auth, PaginationResult } from "convex/server";
import { components, internal } from "./_generated/api.js";
import { ConvexError, v } from "convex/values";
import { eventDoc, eventFields, Xquik } from "xquik-convex";
import { internalAction, internalMutation, query } from "./_generated/server.js";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { EventDoc } from "xquik-convex";

const PULL_EVERY_MS = 300_000;

const xquik = new Xquik(components.xquik);

async function requireUser(ctx: { readonly auth: Readonly<Auth> }): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw new ConvexError({ error: "unauthenticated", message: "Sign in first.", status: 401 });
  }
  return identity.subject;
}

const profile = internalAction({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const user = await ctx.runAction(components.xquik.operations.getUser, { id: username });
    if (typeof user.followers !== "number") {
      throw new ConvexError({
        error: "no_follower_count",
        message: `X sent no follower count for ${username}.`,
        status: 502,
      });
    }
    return { followers: user.followers, name: user.name };
  },
  returns: v.object({ followers: v.number(), name: v.string() }),
});

const draft = internalAction({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const created = await ctx.runAction(components.xquik.operations.createDraft, { text });
    await ctx.runAction(components.xquik.operations.deleteDraft, { id: created.id });
    return created.id;
  },
  returns: v.string(),
});

const watch = internalAction({
  args: {},
  handler: async (ctx): Promise<{ endpointId: string; url: string; webhookId: string }> =>
    await xquik.createWebhook(ctx, { eventTypes: ["tweet.new", "tweet.reply"], onEvent: internal.example.onEvent }),
  returns: v.object({ endpointId: v.string(), url: v.string(), webhookId: v.string() }),
});

const onEvent = internalMutation({
  args: { event: eventFields },
  handler: async (ctx, { event }) => {
    await ctx.db.insert("notifications", { eventType: event.eventType, streamEventId: event.streamEventId });
  },
  returns: v.null(),
});

const pull = internalMutation({
  args: {},
  handler: async (ctx) =>
    await xquik.schedule(ctx, "listEvents", { limit: 100 }, { everyMs: PULL_EVERY_MS, key: "events" }),
  returns: v.string(),
});

const events = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }): Promise<PaginationResult<EventDoc>> => {
    await requireUser(ctx);
    return await ctx.runQuery(components.xquik.events.list, { paginationOpts });
  },
  returns: paginationResultValidator(eventDoc),
});

export { draft, events, onEvent, profile, pull, requireUser, watch };
