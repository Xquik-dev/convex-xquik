import type { Infer, Validator, Value } from "convex/values";
import { isList, isRecord } from "./shape.js";
import { v } from "convex/values";

const json: Validator<Value, "required", string> = v.any();

const eventFields = v.object({
  data: json,
  eventType: v.string(),
  monitorId: v.optional(v.string()),
  occurredAt: v.number(),
  streamEventId: v.string(),
});

type EventFields = Infer<typeof eventFields>;

function toValue(value: unknown): Value {
  if (isList(value)) {
    return value.map((item) => toValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toValue(item)]));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}

export { eventFields, json, toValue };
export type { EventFields };
