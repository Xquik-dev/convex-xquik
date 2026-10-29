import { action, env, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { argument, find, send } from "./request.js";
import { ConvexError, v } from "convex/values";
import { deliveryValidator, NONCE_TTL_MS } from "./delivery.js";
import type { GenericId, Infer } from "convex/values";
import { isRecord, none } from "./shape.js";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { FunctionHandle } from "convex/server";
import { internal } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";
import requireApiKey from "./access.js";
import schema from "./schema.js";
import { STREAM_MS } from "./operation.js";

const PURGE_BATCH = 256;
const IMMEDIATELY = 0;

const endpointView = v.object({
  endpointId: v.id("endpoints"),
  testedAt: v.union(v.null(), v.number()),
  url: v.string(),
  webhookId: v.union(v.null(), v.string()),
});

const endpointPage = paginationResultValidator(endpointView);

const endpointDoc = schema.tables.endpoints.validator.extend({ _creationTime: v.number(), _id: v.id("endpoints") });

type EventFields = Infer<typeof schema.tables.events.validator>;

interface EventWriter {
  readonly db: Readonly<Pick<MutationCtx["db"], "get" | "insert" | "query">>;
  readonly scheduler: Readonly<Pick<MutationCtx["scheduler"], "runAfter">>;
}

const createWebhook = find("createWebhook");

function urlOf(token: string): string {
  return `${env.CONVEX_SITE_URL}/webhooks/${token}`;
}

function isHandle(value: string): value is FunctionHandle<"mutation", { event: EventFields }> {
  return value.startsWith("function://");
}

function handleArgs(onEvent: string | undefined): { onEvent?: string } {
  if (typeof onEvent !== "string") {
    return {};
  }
  if (isHandle(onEvent)) {
    return { onEvent };
  }
  throw new ConvexError({
    error: "invalid_handle",
    message: "Pass onEvent as a function handle from createFunctionHandle, or use the Xquik client class.",
    status: 400,
  });
}

async function store(ctx: EventWriter, event: EventFields): Promise<void> {
  const existing = await ctx.db
    .query("events")
    .withIndex("by_stream_event", (range) => range.eq("streamEventId", event.streamEventId))
    .unique();
  if (!existing) {
    await ctx.db.insert("events", event);
  }
}

async function accept(
  ctx: EventWriter,
  endpointId: GenericId<"endpoints">,
  event: EventFields,
): Promise<"stored" | "duplicate"> {
  const { streamEventId } = event;
  const receipt = await ctx.db
    .query("receipts")
    .withIndex("by_event", (range) => range.eq("endpointId", endpointId).eq("streamEventId", streamEventId))
    .unique();
  if (receipt) {
    return "duplicate";
  }
  await ctx.db.insert("receipts", { endpointId, streamEventId });
  await store(ctx, event);
  const found = await ctx.db.get("endpoints", endpointId);
  if (found && typeof found.onEvent === "string" && isHandle(found.onEvent)) {
    await ctx.scheduler.runAfter(IMMEDIATELY, found.onEvent, { event });
  }
  return "stored";
}

const insert = internalMutation({
  args: {
    onEvent: v.optional(v.string()),
    secret: v.string(),
    token: v.string(),
    webhookId: v.optional(v.string()),
  },
  handler: async (ctx, args) => await ctx.db.insert("endpoints", args),
  returns: v.id("endpoints"),
});

const create = action({
  args: { eventTypes: argument(createWebhook, "eventTypes"), onEvent: v.optional(v.string()) },
  handler: async (
    ctx,
    { eventTypes, onEvent },
  ): Promise<{ endpointId: GenericId<"endpoints">; url: string; webhookId: string }> => {
    const apiKey = requireApiKey(env.XQUIK_API_KEY);
    const handle = handleArgs(onEvent);
    const token = crypto.randomUUID();
    const url = urlOf(token);
    const created = await send(createWebhook, { eventTypes, url }, { apiKey, streamMs: STREAM_MS });
    if (!isRecord(created) || typeof created["id"] !== "string" || typeof created["secret"] !== "string") {
      throw new ConvexError({
        error: "invalid_response",
        message: "Xquik returned no webhook ID or secret.",
        status: 502,
      });
    }
    const endpointId = await ctx.runMutation(
      internal.webhooks.insert,
      Object.assign(handle, { secret: created["secret"], token, webhookId: created["id"] }),
    );
    return { endpointId, url, webhookId: created["id"] };
  },
  returns: v.object({ endpointId: v.id("endpoints"), url: v.string(), webhookId: v.string() }),
});

const add = mutation({
  args: { onEvent: v.optional(v.string()), secret: v.string() },
  handler: async (ctx, { onEvent, secret }) => {
    requireApiKey(env.XQUIK_API_KEY);
    const handle = handleArgs(onEvent);
    const token = crypto.randomUUID();
    const endpointId = await ctx.db.insert("endpoints", Object.assign(handle, { secret, token }));
    return { endpointId, url: urlOf(token) };
  },
  returns: v.object({ endpointId: v.id("endpoints"), url: v.string() }),
});

const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }): Promise<Infer<typeof endpointPage>> => {
    requireApiKey(env.XQUIK_API_KEY);
    const endpoints = await ctx.db.query("endpoints").order("desc").paginate(paginationOpts);
    return Object.assign(endpoints, {
      page: endpoints.page.map(({ _id, testedAt, token, webhookId }) => ({
        endpointId: _id,
        testedAt: testedAt ?? none,
        url: urlOf(token),
        webhookId: webhookId ?? none,
      })),
    });
  },
  returns: endpointPage,
});

const endpoint = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) =>
    await ctx.db
      .query("endpoints")
      .withIndex("by_token", (range) => range.eq("token", token))
      .unique(),
  returns: v.union(v.null(), endpointDoc),
});

const webhookOf = internalQuery({
  args: { endpointId: v.id("endpoints") },
  handler: async (ctx, { endpointId }) => {
    const found = await ctx.db.get("endpoints", endpointId);
    if (!found) {
      return found;
    }
    return found.webhookId;
  },
  returns: v.union(v.null(), v.string()),
});

const drop = internalMutation({
  args: { endpointId: v.id("endpoints") },
  handler: async (ctx, { endpointId }) => {
    await ctx.db.delete("endpoints", endpointId);
  },
  returns: v.null(),
});

const remove = action({
  args: { endpointId: v.id("endpoints") },
  handler: async (ctx, { endpointId }): Promise<void> => {
    const apiKey = requireApiKey(env.XQUIK_API_KEY);
    const webhookId = await ctx.runQuery(internal.webhooks.webhookOf, { endpointId });
    if (typeof webhookId === "string") {
      await send(find("deleteWebhook"), { id: webhookId }, { apiKey, streamMs: STREAM_MS });
    }
    await ctx.runMutation(internal.webhooks.drop, { endpointId });
  },
  returns: v.null(),
});

const ingest = internalMutation({
  args: {
    delivery: deliveryValidator,
    endpointId: v.id("endpoints"),
    nonce: v.string(),
  },
  handler: async (
    ctx,
    { delivery: arrived, endpointId, nonce },
  ): Promise<"replay" | "test" | "stored" | "duplicate"> => {
    const seen = await ctx.db
      .query("nonces")
      .withIndex("by_nonce", (range) => range.eq("endpointId", endpointId).eq("nonce", nonce))
      .unique();
    if (seen) {
      return "replay";
    }
    const now = Date.now();
    await ctx.db.insert("nonces", { endpointId, expiresAt: now + NONCE_TTL_MS, nonce });
    if (arrived.kind === "test") {
      await ctx.db.patch("endpoints", endpointId, { testedAt: now });
      return "test";
    }
    return await accept(ctx, endpointId, arrived.event);
  },
  returns: v.union(v.literal("replay"), v.literal("test"), v.literal("stored"), v.literal("duplicate")),
});

const purge = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const expired = await ctx.db
      .query("nonces")
      .withIndex("by_expiry", (range) => range.lt("expiresAt", Date.now()))
      .take(PURGE_BATCH);
    await Promise.all(
      expired.map(async ({ _id }) => {
        await ctx.db.delete("nonces", _id);
      }),
    );
    if (expired.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(IMMEDIATELY, internal.webhooks.purge, {});
    }
    return expired.length;
  },
  returns: v.number(),
});

export { add, create, drop, endpoint, ingest, insert, list, purge, PURGE_BATCH, remove, store, webhookOf };
