import { paginationOptsValidator, paginationResultValidator, type Auth, type PaginationResult } from "convex/server";
import { ConvexError, v } from "convex/values";
import { eventDoc, eventFields, Xquik, type EventDoc } from "convex-xquik";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation, query } from "./_generated/server.js";

const xquik = new Xquik(components.xquik);

export async function requireUser(ctx: { readonly auth: Auth }): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new ConvexError({ status: 401, error: "unauthenticated", message: "Sign in first." });
  return identity.subject;
}

function field(value: unknown, name: string): unknown {
  return value instanceof Object ? Object.entries(value).find(([key]) => key === name)?.[1] : undefined;
}

export const profile = internalAction({
  args: { username: v.string() },
  returns: v.object({ name: v.string(), followers: v.number() }),
  handler: async (ctx, { username }) => {
    const user: unknown = await ctx.runAction(components.xquik.operations.getUser, { id: username });
    const name = field(user, "name");
    const followers = field(user, "followers");
    if (typeof name !== "string" || typeof followers !== "number") {
      throw new ConvexError({ status: 502, error: "unexpected_profile", message: `No profile for ${username}.` });
    }
    return { name, followers };
  },
});

export const draft = internalAction({
  args: { text: v.string() },
  returns: v.string(),
  handler: async (ctx, { text }) => {
    const created: unknown = await ctx.runAction(components.xquik.operations.createDraft, { text });
    const id = field(created, "id");
    if (typeof id !== "string")
      throw new ConvexError({ status: 502, error: "unexpected_draft", message: "No draft ID." });
    await ctx.runAction(components.xquik.operations.deleteDraft, { id });
    return id;
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
