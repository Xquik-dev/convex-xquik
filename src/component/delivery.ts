import type { Value } from "convex/values";
import { parseOrText } from "./request.js";
import { isList, isRecord } from "./shape.js";
import { toValue, type EventFields } from "./values.js";

export const TOLERANCE_MS = 5 * 60 * 1000;
export const NONCE_TTL_MS = 2 * TOLERANCE_MS;

const encoder = new TextEncoder();

export type Check = { readonly ok: true; readonly nonce: string } | { readonly ok: false; readonly reason: string };

function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: hex.length / 2 }, (_item, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

export async function check(secret: string, headers: Headers, body: ArrayBuffer, now: number): Promise<Check> {
  const timestamp = String(headers.get("x-xquik-timestamp"));
  const nonce = String(headers.get("x-xquik-nonce"));
  const mac = /^sha256=([0-9a-f]{64})$/.exec(String(headers.get("x-xquik-signature")))?.[1];
  if (!/^\d{1,16}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > TOLERANCE_MS) {
    return { ok: false, reason: "stale timestamp" };
  }
  if (!/^[0-9a-f]{32}$/.test(nonce) || mac === undefined) {
    return { ok: false, reason: "bad signature" };
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const prefix = encoder.encode(`${timestamp}.${nonce}.`);
  const message = new Uint8Array(prefix.length + body.byteLength);
  message.set(prefix);
  message.set(new Uint8Array(body), prefix.length);
  const valid = await crypto.subtle.verify("HMAC", key, bytes(mac), message);
  return valid ? { ok: true, nonce } : { ok: false, reason: "bad signature" };
}

export function readEvent(item: unknown, names: { readonly id: string; readonly type: string }): EventFields | null {
  if (!isRecord(item)) return null;
  const { [names.id]: streamEventId, [names.type]: eventType, occurredAt, monitorId, data } = item;
  const time = typeof occurredAt === "string" ? Date.parse(occurredAt) : Number.NaN;
  if (typeof streamEventId !== "string" || typeof eventType !== "string" || Number.isNaN(time)) return null;
  return {
    streamEventId,
    eventType,
    occurredAt: time,
    ...(typeof monitorId === "string" ? { monitorId } : {}),
    data: toValue(data),
  };
}

export type Delivery = { readonly kind: "test" } | { readonly kind: "event"; readonly event: EventFields };

export function readDelivery(raw: string): Delivery | null {
  const body = parseOrText(raw);
  if (isRecord(body) && body["eventType"] === "webhook.test") return { kind: "test" };
  const event = readEvent(body, { id: "streamEventId", type: "eventType" });
  return event === null ? null : { kind: "event", event };
}

export function pulledEvents(result: Value): EventFields[] {
  const events = isRecord(result) ? result["events"] : undefined;
  return isList(events) ? events.flatMap((item) => readEvent(item, { id: "id", type: "type" }) ?? []) : [];
}
