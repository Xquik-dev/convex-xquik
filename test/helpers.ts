import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import schema from "#src/component/schema.ts";
import spec from "#openapi.json" with { type: "json" };
import type { TestConvex } from "convex-test";
import type { Value } from "convex/values";
import { vi } from "vitest";

const SECRET_BYTES = 32;
const HEX_RADIX = 16;
const HEX_DIGITS = 2;

const modules = import.meta.glob("#src/component/**/*.ts");

const SECRET = "ab".repeat(SECRET_BYTES);
const SITE = "https://happy-otter-123.convex.site/xquik";

const encoder = new TextEncoder();

function componentTest(): TestConvex<typeof schema> {
  vi.stubEnv("XQUIK_API_KEY", "xq_test");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  return convexTest(schema, modules);
}

interface Signed {
  readonly headers: Record<string, string>;
  readonly body: string;
}

function hex(bytes: Readonly<ArrayBuffer>): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(HEX_RADIX).padStart(HEX_DIGITS, "0")).join("");
}

async function sign(
  body: string,
  options: { readonly secret?: string; readonly timestamp?: string; readonly nonce?: string } = {},
): Promise<Signed> {
  const timestamp = options.timestamp ?? String(Date.now());
  const nonce = options.nonce ?? crypto.randomUUID().replaceAll("-", "");
  const secret = encoder.encode(options.secret ?? SECRET);
  const key = await crypto.subtle.importKey("raw", secret, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${nonce}.${body}`)));
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-xquik-nonce": nonce,
      "x-xquik-signature": `sha256=${mac}`,
      "x-xquik-timestamp": timestamp,
    },
  };
}

function delivery(eventType: string, streamEventId: string, extra: Readonly<Record<string, unknown>> = {}): string {
  const fields = {
    data: { id: "1893456789012345678", text: "The future is now." },
    deliveryId: `d${streamEventId}`,
    eventType,
    monitorId: "10",
    monitorType: "account",
    occurredAt: "2026-10-28T19:00:00.000Z",
    schemaVersion: 1,
    streamEventId,
    username: "elonmusk",
    xUserId: "44196397",
  };
  return JSON.stringify(Object.assign(fields, extra));
}

const TEST_ALERT = JSON.stringify({
  data: { message: "Test delivery from Xquik" },
  eventType: "webhook.test",
  timestamp: "2026-10-28T19:00:00.000Z",
});

interface Recorded {
  readonly method: string;
  readonly url: Readonly<Omit<URL, "searchParams">> & { readonly searchParams: Readonly<URLSearchParams> };
  readonly headers: Readonly<Headers>;
  readonly body: string;
}

function textBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  return "";
}

function stubFetch(answer: (request: Recorded) => Response | Promise<Response>): Recorded[] {
  const recorded: Recorded[] = [];
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const request = {
      body: textBody(init.body),
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
      url: new URL(new Request(input).url),
    };
    recorded.push(request);
    return await answer(request);
  };
  vi.stubGlobal("fetch", fakeFetch);
  return recorded;
}

function readSpec(): unknown {
  return spec;
}

function isConvexError(error: unknown): error is ConvexError<Value> {
  return error instanceof ConvexError;
}

function rejectionValue(error: unknown): unknown {
  if (isConvexError(error)) {
    return error.data;
  }
  return error;
}

async function rejection(promise: Readonly<Promise<unknown>>): Promise<unknown> {
  return await promise.then(() => "resolved", rejectionValue);
}

export { componentTest, delivery, readSpec, rejection, SECRET, sign, SITE, stubFetch, TEST_ALERT };
export type { Recorded, Signed };
