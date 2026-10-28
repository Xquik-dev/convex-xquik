import type { FunctionHandle } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { action, env, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { NONCE_TTL_MS } from "./delivery.js";
import { eventFields, type EventFields } from "./values.js";
import { argument, find, send } from "./request.js";
import schema from "./schema.js";
import { isRecord } from "./shape.js";
import { STREAM_MS } from "./operation.js";

export const PURGE_BATCH = 256;

const endpointView = v.object({
  endpointId: v.id("endpoints"),
  url: v.string(),
  webhookId: v.optional(v.string()),
  testedAt: v.optional(v.number()),
});

const endpointDoc = schema.tables.endpoints.validator.extend({ _id: v.id("endpoints"), _creationTime: v.number() });

const createWebhook = find("createWebhook");

function urlOf(token: string): string {
  return `${env.CONVEX_SITE_URL}/webhooks/${token}`;
}

function isHandle(value: string): value is FunctionHandle<"mutation", { event: EventFields }> {
  return value.startsWith("function://");
}

function handleArgs(onEvent: string | undefined): { onEvent?: string } {
  if (onEvent === undefined) return {};
  if (isHandle(onEvent)) return { onEvent };
  throw new ConvexError({
    status: 400,
    error: "invalid_handle",
    message: "Pass onEvent as a function handle from createFunctionHandle, or use the Xquik client class.",
  });
}

export async function store(ctx: MutationCtx, event: EventFields, onEvent?: string): Promise<"stored" | "duplicate"> {
  const existing = await ctx.db
    .query("events")
    .withIndex("by_stream_event", (q) => q.eq("streamEventId", event.streamEventId))
    .unique();
  if (existing !== null) return "duplicate";
  await ctx.db.insert("events", event);
  if (onEvent !== undefined && isHandle(onEvent)) await ctx.scheduler.runAfter(0, onEvent, { event });
  return "stored";
}

export const insert = internalMutation({
  args: {
    token: v.string(),
    secret: v.string(),
    webhookId: v.optional(v.string()),
    onEvent: v.optional(v.string()),
  },
  returns: v.id("endpoints"),
  handler: async (ctx, args) => await ctx.db.insert("endpoints", args),
});

export const create = action({
  args: { eventTypes: argument(createWebhook, "eventTypes"), onEvent: v.optional(v.string()) },
  returns: v.object({ endpointId: v.id("endpoints"), url: v.string(), webhookId: v.string() }),
  handler: async (
    ctx,
    { eventTypes, onEvent },
  ): Promise<{ endpointId: Id<"endpoints">; url: string; webhookId: string }> => {
    const handle = handleArgs(onEvent);
    const token = crypto.randomUUID();
    const url = urlOf(token);
    const created = await send(createWebhook, { eventTypes, url }, { apiKey: env.XQUIK_API_KEY, streamMs: STREAM_MS });
    const { id, secret } = isRecord(created) ? created : {};
    if (typeof id !== "string" || typeof secret !== "string") {
      throw new ConvexError({
        status: 502,
        error: "invalid_response",
        message: "Xquik returned no webhook ID or secret.",
      });
    }
    const endpointId = await ctx.runMutation(internal.webhooks.insert, { token, secret, webhookId: id, ...handle });
    return { endpointId, url, webhookId: id };
  },
});

export const add = mutation({
  args: { secret: v.string(), onEvent: v.optional(v.string()) },
  returns: v.object({ endpointId: v.id("endpoints"), url: v.string() }),
  handler: async (ctx, { secret, onEvent }) => {
    const handle = handleArgs(onEvent);
    const token = crypto.randomUUID();
    const endpointId = await ctx.db.insert("endpoints", { token, secret, ...handle });
    return { endpointId, url: urlOf(token) };
  },
});

export const list = query({
  args: {},
  returns: v.array(endpointView),
  handler: async (ctx) => {
    const endpoints = await ctx.db.query("endpoints").take(100);
    return endpoints.map(({ _id, token, webhookId, testedAt }) => ({
      endpointId: _id,
      url: urlOf(token),
      ...(webhookId === undefined ? {} : { webhookId }),
      ...(testedAt === undefined ? {} : { testedAt }),
    }));
  },
});

export const endpoint = internalQuery({
  args: { token: v.string() },
  returns: v.union(v.null(), endpointDoc),
  handler: async (ctx, { token }) =>
    await ctx.db
      .query("endpoints")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique(),
});

export const webhookOf = internalQuery({
  args: { endpointId: v.id("endpoints") },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { endpointId }) => (await ctx.db.get("endpoints", endpointId))?.webhookId ?? null,
});

export const drop = internalMutation({
  args: { endpointId: v.id("endpoints") },
  returns: v.null(),
  handler: async (ctx, { endpointId }) => {
    await ctx.db.delete("endpoints", endpointId);
    return null;
  },
});

export const remove = action({
  args: { endpointId: v.id("endpoints") },
  returns: v.null(),
  handler: async (ctx, { endpointId }): Promise<null> => {
    const webhookId = await ctx.runQuery(internal.webhooks.webhookOf, { endpointId });
    if (webhookId !== null) {
      await send(find("deleteWebhook"), { id: webhookId }, { apiKey: env.XQUIK_API_KEY, streamMs: STREAM_MS });
    }
    await ctx.runMutation(internal.webhooks.drop, { endpointId });
    return null;
  },
});

export const ingest = internalMutation({
  args: {
    endpointId: v.id("endpoints"),
    nonce: v.string(),
    event: v.union(v.null(), eventFields),
  },
  returns: v.union(v.literal("replay"), v.literal("test"), v.literal("stored"), v.literal("duplicate")),
  handler: async (ctx, { endpointId, nonce, event }): Promise<"replay" | "test" | "stored" | "duplicate"> => {
    const seen = await ctx.db
      .query("nonces")
      .withIndex("by_nonce", (q) => q.eq("endpointId", endpointId).eq("nonce", nonce))
      .unique();
    if (seen !== null) return "replay";
    const now = Date.now();
    await ctx.db.insert("nonces", { endpointId, nonce, expiresAt: now + NONCE_TTL_MS });
    if (event !== null) return await store(ctx, event, (await ctx.db.get("endpoints", endpointId))?.onEvent);
    await ctx.db.patch("endpoints", endpointId, { testedAt: now });
    return "test";
  },
});

export const purge = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const expired = await ctx.db
      .query("nonces")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(PURGE_BATCH);
    await Promise.all(
      expired.map(async ({ _id }) => {
        await ctx.db.delete("nonces", _id);
      }),
    );
    if (expired.length === PURGE_BATCH) await ctx.scheduler.runAfter(0, internal.webhooks.purge, {});
    return expired.length;
  },
});
