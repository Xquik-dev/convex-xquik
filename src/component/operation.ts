import { action, env } from "./_generated/server.js";
import { fields, find, send, validator } from "./request.js";
import type { Args } from "./request.js";
import data from "./registry.json" with { type: "json" };
import type { RegisteredAction } from "convex/server";
import type { Value } from "convex/values";

type Action = RegisteredAction<"public", Args, Promise<Value>>;

const STREAM_MS = 10_000;

function operation(id: string): Action {
  const definition = find(id);
  return action({
    args: fields(definition.args),
    handler: async (_ctx, args) => await send(definition, args, { apiKey: env.XQUIK_API_KEY, streamMs: STREAM_MS }),
    returns: validator(definition.result),
  });
}

function operations(): Readonly<Record<keyof typeof data.operations, Action>>;
function operations(): Readonly<Record<string, Action>> {
  return Object.fromEntries(Object.keys(data.operations).map((id) => [id, operation(id)]));
}

export { STREAM_MS, operations };
