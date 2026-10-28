import type { RegisteredAction } from "convex/server";
import type { Value } from "convex/values";
import { action, env } from "./_generated/server.js";
import { fields, find, send, type Args } from "./request.js";
import { json } from "./values.js";

export const STREAM_MS = 10_000;

export function operation(id: string): RegisteredAction<"public", Args, Promise<Value>> {
  const definition = find(id);
  return action({
    args: fields(definition.args),
    returns: json,
    handler: async (_ctx, args) => await send(definition, args, { apiKey: env.XQUIK_API_KEY, streamMs: STREAM_MS }),
  });
}
