import { v, type Infer, type Validator, type Value } from "convex/values";
import { isList, isRecord } from "./shape.js";

export const json: Validator<Value, "required", string> = v.any();

export const eventFields = v.object({
  streamEventId: v.string(),
  eventType: v.string(),
  occurredAt: v.number(),
  monitorId: v.optional(v.string()),
  data: json,
});

export type EventFields = Infer<typeof eventFields>;

export function toValue(value: unknown): Value {
  if (isList(value)) return value.map(toValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toValue(item)]));
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}
