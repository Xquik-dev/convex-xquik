import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/component/_generated/api.js";
import { registry } from "../src/component/request.js";
import { isList, isRecord, type Shape } from "../src/component/shape.js";
import { componentTest, delivery, readSpec, sign, SECRET, stubFetch, TEST_ALERT } from "./helpers.js";

const spec = readSpec();
const paths = isRecord(spec) && isRecord(spec["paths"]) ? spec["paths"] : {};
const rootSecurity = isRecord(spec) ? spec["security"] : undefined;
const schemas =
  isRecord(spec) && isRecord(spec["components"]) && isRecord(spec["components"]["schemas"])
    ? spec["components"]["schemas"]
    : {};

function isPublic(security: unknown): boolean {
  return (
    isList(security) &&
    security.some(
      (requirement) => isRecord(requirement) && (Object.keys(requirement).length === 0 || "apiKey" in requirement),
    )
  );
}

const operations = Object.entries(paths).flatMap(([path, item]) =>
  ["get", "put", "post", "patch", "delete"].flatMap((method) => {
    const op = isRecord(item) ? item[method] : undefined;
    if (!isRecord(op) || typeof op["operationId"] !== "string") return [];
    return isPublic(op["security"] ?? rootSecurity)
      ? [{ id: op["operationId"], method: method.toUpperCase(), path }]
      : [];
  }),
);

function enumOf(name: string): string[] {
  const schema = schemas[name];
  const values = isRecord(schema) ? schema["enum"] : undefined;
  return isList(values) ? values.filter((value) => typeof value === "string") : [];
}

const eventTypes = [...enumOf("EventType"), ...enumOf("PostEventType")];

function sample(shape: Shape): Value {
  if (shape === "string") return "elonmusk";
  if (shape === "number") return 1;
  if (shape === "boolean") return true;
  if (shape === "null" || shape === "any") return null;
  if ("literal" in shape) return shape.literal;
  if ("array" in shape || "record" in shape) return "array" in shape ? [] : {};
  if ("object" in shape) return required(shape.object);
  return sample(shape.union[0] ?? "null");
}

function required(
  fields: Readonly<Record<string, { readonly shape: Shape; readonly optional: boolean }>>,
): Record<string, Value> {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([name, field]) => (field.optional ? [] : [[name, sample(field.shape)]])),
  );
}

function answer(id: string): Response {
  const kind = registry[id]?.response;
  if (kind === "bytes") return new Response(new Uint8Array([1, 2, 3]));
  if (kind === "events") return new Response('id: 1\nevent: tweet.new\ndata: {"id":"1"}\n\n');
  if (kind === "none") return new Response(null, { status: 202 });
  return Response.json({ ok: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("every public operation in openapi.json", () => {
  test("the spec lists 190 public operations", () => {
    expect(operations).toHaveLength(190);
  });

  test.each(operations)("$id is a component action that calls $method $path", async ({ id, method, path }) => {
    const t = componentTest();
    const recorded = stubFetch(() => answer(id));
    const args = required(registry[id]?.args ?? {});
    await t.action(makeFunctionReference<"action", Record<string, Value>, Value>(`operations:${id}`), args);
    const expected = path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
      encodeURIComponent(JSON.stringify(args[name]).replaceAll('"', "")),
    );
    expect(recorded.map(({ method: sent, url }) => `${sent} ${url.pathname}`)).toEqual([`${method} ${expected}`]);
    expect(recorded[0]?.headers.get("x-api-key")).toBe("xq_test");
  });
});

describe("every event type in openapi.json", () => {
  test("the spec lists 40 event types", () => {
    expect(eventTypes).toHaveLength(40);
  });

  test.each(eventTypes)("the receiver stores a signed %s delivery once", async (eventType) => {
    const t = componentTest();
    const { url } = await t.mutation(api.webhooks.add, { secret: SECRET });
    const path = new URL(url).pathname.replace("/xquik", "");
    const first = sign(delivery(eventType, "9001"));
    expect(await (await t.fetch(path, { method: "POST", ...first })).text()).toBe("stored");
    const retry = sign(delivery(eventType, "9001"));
    expect(await (await t.fetch(path, { method: "POST", ...retry })).text()).toBe("duplicate");
    const stored = await t.query(api.events.get, { streamEventId: "9001" });
    expect(stored).toMatchObject({ eventType, streamEventId: "9001", monitorId: "10" });
  });

  test("the receiver answers the webhook.test alert", async () => {
    const t = componentTest();
    const { url } = await t.mutation(api.webhooks.add, { secret: SECRET });
    const response = await t.fetch(new URL(url).pathname.replace("/xquik", ""), {
      method: "POST",
      ...sign(TEST_ALERT),
    });
    expect([response.status, await response.text()]).toEqual([200, "test"]);
  });
});
