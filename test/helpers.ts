import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { convexTest, type TestConvex } from "convex-test";
import { ConvexError, type Value } from "convex/values";
import { vi } from "vitest";
import schema from "../src/component/schema.js";

export const modules = import.meta.glob("../src/component/**/*.ts");

export const SECRET = "ab".repeat(32);
export const SITE = "https://happy-otter-123.convex.site/xquik";

export function componentTest(): TestConvex<typeof schema> {
  vi.stubEnv("XQUIK_API_KEY", "xq_test");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  return convexTest(schema, modules);
}

export interface Signed {
  readonly headers: Record<string, string>;
  readonly body: string;
}

export function sign(
  body: string,
  options: { readonly secret?: string; readonly timestamp?: string; readonly nonce?: string } = {},
): Signed {
  const timestamp = options.timestamp ?? String(Date.now());
  const nonce = options.nonce ?? randomBytes(16).toString("hex");
  const mac = createHmac("sha256", options.secret ?? SECRET)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest("hex");
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-xquik-timestamp": timestamp,
      "x-xquik-nonce": nonce,
      "x-xquik-signature": `sha256=${mac}`,
    },
  };
}

export function delivery(eventType: string, streamEventId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventType,
    schemaVersion: 1,
    deliveryId: `d${streamEventId}`,
    streamEventId,
    occurredAt: "2026-10-28T19:00:00.000Z",
    monitorId: "10",
    monitorType: "account",
    username: "elonmusk",
    xUserId: "44196397",
    data: { id: "1893456789012345678", text: "The future is now." },
    ...extra,
  });
}

export const TEST_ALERT = JSON.stringify({
  data: { message: "Test delivery from Xquik" },
  eventType: "webhook.test",
  timestamp: "2026-10-28T19:00:00.000Z",
});

export interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

export function stubFetch(answer: (request: Recorded) => Response | Promise<Response>): Recorded[] {
  const recorded: Recorded[] = [];
  vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
    const request = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : "",
    };
    recorded.push(request);
    return await answer(request);
  });
  return recorded;
}

export function readSpec(): unknown {
  const spec: unknown = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
  return spec;
}

function isConvexError(error: unknown): error is ConvexError<Value> {
  return error instanceof ConvexError;
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => "resolved",
    (error: unknown) => (isConvexError(error) ? error.data : error),
  );
}
