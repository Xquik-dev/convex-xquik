import { eventFields, toValue } from "./values.js";
import { isList, isRecord } from "./shape.js";
import type { EventFields } from "./values.js";
import type { Infer } from "convex/values";
import { parseOrText } from "./request.js";
import { v } from "convex/values";

const TOLERANCE_MS = 300_000;
const WINDOWS_PER_NONCE = 2;
const NONCE_TTL_MS = WINDOWS_PER_NONCE * TOLERANCE_MS;
const HEX_PER_BYTE = 2;
const TIMESTAMP = /^\d{1,16}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const SIGNATURE = /^sha256=(?<mac>[0-9a-f]{64})$/u;

const encoder = new TextEncoder();

type Check = { readonly ok: true; readonly nonce: string } | { readonly ok: false; readonly reason: string };

const deliveryValidator = v.union(
  v.object({ kind: v.literal("test") }),
  v.object({ event: eventFields, kind: v.literal("event") }),
);

type Delivery = Infer<typeof deliveryValidator>;

type Reading = Delivery | { readonly kind: "invalid" };

function bytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: hex.length / HEX_PER_BYTE }, (_item, index) => {
    const start = index * HEX_PER_BYTE;
    return Number.parseInt(hex.slice(start, start + HEX_PER_BYTE), 16);
  });
}

async function verify(secret: string, signed: string, mac: string, body: Readonly<ArrayBuffer>): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, [
    "verify",
  ]);
  const prefix = encoder.encode(signed);
  const message = new Uint8Array(prefix.length + body.byteLength);
  message.set(prefix);
  message.set(new Uint8Array(body), prefix.length);
  return await crypto.subtle.verify("HMAC", key, bytes(mac), message);
}

async function check(
  secret: string,
  headers: Readonly<Headers>,
  body: Readonly<ArrayBuffer>,
  now: number,
): Promise<Check> {
  const timestamp = String(headers.get("x-xquik-timestamp"));
  const nonce = String(headers.get("x-xquik-nonce"));
  const signature = SIGNATURE.exec(String(headers.get("x-xquik-signature")));
  if (!TIMESTAMP.test(timestamp) || Math.abs(now - Number(timestamp)) > TOLERANCE_MS) {
    return { ok: false, reason: "stale timestamp" };
  }
  if (!NONCE.test(nonce) || !signature) {
    return { ok: false, reason: "bad signature" };
  }
  if (await verify(secret, `${timestamp}.${nonce}.`, String(signature[1]), body)) {
    return { nonce, ok: true };
  }
  return { ok: false, reason: "bad signature" };
}

function timeOf(value: unknown): number {
  if (typeof value === "string") {
    return Date.parse(value);
  }
  return Number.NaN;
}

function monitorOf(monitorId: unknown): { monitorId?: string } {
  if (typeof monitorId === "string") {
    return { monitorId };
  }
  return {};
}

function readEvent(
  item: unknown,
  names: { readonly id: string; readonly type: string },
): readonly [] | readonly [EventFields] {
  if (!isRecord(item)) {
    return [];
  }
  const { [names.id]: streamEventId, [names.type]: eventType, data, monitorId, occurredAt } = item;
  const time = timeOf(occurredAt);
  if (typeof streamEventId !== "string" || typeof eventType !== "string" || Number.isNaN(time)) {
    return [];
  }
  return [Object.assign(monitorOf(monitorId), { data: toValue(data), eventType, occurredAt: time, streamEventId })];
}

function readDelivery(raw: string): Reading {
  const body = parseOrText(raw);
  if (isRecord(body) && body["eventType"] === "webhook.test") {
    return { kind: "test" };
  }
  const [event] = readEvent(body, { id: "streamEventId", type: "eventType" });
  if (!event) {
    return { kind: "invalid" };
  }
  return { event, kind: "event" };
}

function pulledEvents(result: unknown): EventFields[] {
  if (!isRecord(result) || !isList(result["events"])) {
    return [];
  }
  return result["events"].flatMap((item) => readEvent(item, { id: "id", type: "type" }));
}

export { check, deliveryValidator, NONCE_TTL_MS, pulledEvents, readDelivery };
export type { Check, Delivery, Reading };
