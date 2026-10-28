import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/component/_generated/api.js";
import { registry, schema } from "../src/component/request.js";
import { isList, isRecord, type Field, type Shape } from "../src/component/shape.js";
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
      ? [{ id: op["operationId"], method: method.toUpperCase(), path, responses: op["responses"] }]
      : [];
  }),
);

function listOf(value: unknown): readonly unknown[] {
  return isList(value) ? value : [];
}

function target(value: unknown): Record<string, unknown> {
  const ref = isRecord(value) ? value["$ref"] : undefined;
  if (typeof ref !== "string") return isRecord(value) ? value : {};
  const tokens = ref
    .slice(2)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  return target(tokens.reduce<unknown>((parent, token) => (isRecord(parent) ? parent[token] : undefined), spec));
}

function joined(value: unknown): Record<string, unknown> {
  const { allOf, ...node } = target(value);
  const parts = [node, ...listOf(allOf).map(joined)];
  return parts.reduce<Record<string, unknown>>(
    (merged, part) => ({
      ...merged,
      ...part,
      properties: {
        ...(isRecord(merged["properties"]) ? merged["properties"] : {}),
        ...(isRecord(part["properties"]) ? part["properties"] : {}),
      },
      required: [...listOf(merged["required"]), ...listOf(part["required"])],
    }),
    {},
  );
}

function example(value: unknown): unknown {
  const { oneOf, anyOf, ...node } = joined(value);
  const variant = [...listOf(oneOf), ...listOf(anyOf)][0];
  if (variant !== undefined) return example({ allOf: [node, variant] });
  if (node["const"] !== undefined) return node["const"];
  if (isList(node["enum"])) return node["enum"][0];
  const type: unknown = [node["type"]].flat()[0];
  if (type === "string") return "NASA";
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (type === "array") return [];
  const needed = listOf(node["required"]);
  return Object.fromEntries(
    Object.entries(isRecord(node["properties"]) ? node["properties"] : {})
      .filter(([name]) => needed.includes(name))
      .map(([name, property]) => [name, example(property)]),
  );
}

function documented(responses: unknown): unknown {
  const answers = Object.entries(isRecord(responses) ? responses : {}).filter(([code]) => code.startsWith("2"));
  const media = answers
    .map(([, success]) => target(success)["content"])
    .find((content) => isRecord(content) && "application/json" in content);
  return example(isRecord(media) && isRecord(media["application/json"]) ? media["application/json"]["schema"] : {});
}

function enumOf(name: string): string[] {
  const found = schemas[name];
  const values = isRecord(found) ? found["enum"] : undefined;
  return isList(values) ? values.filter((value) => typeof value === "string") : [];
}

const eventTypes = [...enumOf("EventType"), ...enumOf("PostEventType")];

function sample(shape: Shape): Value {
  if (shape === "string") return "elonmusk";
  if (shape === "number") return 1;
  if (shape === "boolean") return true;
  if (shape === "null" || shape === "any" || shape === "bytes") return null;
  if ("ref" in shape) return sample(schema(shape.ref));
  if ("literal" in shape) return shape.literal;
  if ("array" in shape || "record" in shape) return "array" in shape ? [] : {};
  if ("object" in shape) return required(shape.object);
  return sample(shape.union[0] ?? "null");
}

function required(fields: Readonly<Record<string, Field>>): Record<string, Value> {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([name, field]) => (field.optional ? [] : [[name, sample(field.shape)]])),
  );
}

function answer(id: string, responses: unknown): { readonly response: Response; readonly result: unknown } {
  const operation = registry.operations[id];
  if (operation?.response === "bytes") return { response: new Response(new Uint8Array([1, 2, 3])), result: [1, 2, 3] };
  if (operation?.response === "events") {
    const response = new Response('id: 1\nevent: tweet.new\ndata: {"id":"1"}\n\n');
    return { response, result: [{ id: "1", event: "tweet.new", data: { id: "1" } }] };
  }
  if (operation?.response === "none") return { response: new Response(null, { status: 202 }), result: null };
  const result = documented(responses);
  return { response: Response.json(result), result };
}

function plain(value: Value): unknown {
  return value instanceof ArrayBuffer ? [...new Uint8Array(value)] : value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("every public operation in openapi.json", () => {
  test("the spec lists 190 public operations", () => {
    expect(operations).toHaveLength(190);
  });

  test.each(operations)(
    "$id is a component action that calls $method $path",
    async ({ id, method, path, responses }) => {
      const t = componentTest();
      const expected = answer(id, responses);
      const recorded = stubFetch(() => expected.response);
      const args = required(registry.operations[id]?.args ?? {});
      const result = await t.action(
        makeFunctionReference<"action", Record<string, Value>, Value>(`operations:${id}`),
        args,
      );
      expect(plain(result)).toEqual(expected.result);
      const wire = path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
        encodeURIComponent(JSON.stringify(args[name]).replaceAll('"', "")),
      );
      expect(recorded.map(({ method: sent, url }) => `${sent} ${url.pathname}`)).toEqual([`${method} ${wire}`]);
      expect(recorded[0]?.headers.get("x-api-key")).toBe("xq_test");
    },
  );
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
