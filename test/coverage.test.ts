import { componentTest, delivery, readSpec, SECRET, sign, stubFetch, TEST_ALERT } from "./helpers.js";
import { describe, expect, it } from "vitest";
import type { Field, Shape } from "#src/component/shape.ts";
import { find, schema } from "#src/component/request.ts";
import { isList, isRecord } from "#src/component/shape.ts";
import { api } from "#src/component/_generated/api.ts";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";

const NONE = 0;
const PUBLIC_OPERATIONS = 190;
const EVENT_TYPES = 40;
const METHODS = ["get", "put", "post", "patch", "delete"];

const SAMPLES: Readonly<Record<string, unknown>> = {
  array: [],
  boolean: true,
  integer: 1,
  null: null,
  number: 1,
  string: "NASA",
};

const PRIMITIVE_SAMPLES: Readonly<Record<Extract<Shape, string>, Value>> = {
  any: null,
  boolean: true,
  bytes: null,
  null: null,
  number: 1,
  string: "elonmusk",
};

interface Endpoint {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly responses: unknown;
}

interface Expected {
  readonly response: Response;
  readonly result: unknown;
}

type Empty = Extract<
  Shape,
  { readonly array: Shape } | { readonly record: Shape } | { readonly union: readonly Shape[] }
>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) {
    return value;
  }
  return {};
}

function listOf(value: unknown): readonly unknown[] {
  if (isList(value)) {
    return value;
  }
  return [];
}

const spec = record(readSpec());
const paths = record(spec["paths"]);
const rootSecurity = spec["security"];
const schemas = record(record(spec["components"])["schemas"]);

function isPublic(security: unknown): boolean {
  return listOf(security).some(
    (requirement) => isRecord(requirement) && (Object.keys(requirement).length === NONE || "apiKey" in requirement),
  );
}

function publicOperations(path: string, item: unknown): Endpoint[] {
  return METHODS.flatMap((method) => {
    const operation = record(record(item)[method]);
    const id = operation["operationId"];
    if (typeof id !== "string" || !isPublic(operation["security"] ?? rootSecurity)) {
      return [];
    }
    return [{ id, method: method.toUpperCase(), path, responses: operation["responses"] }];
  });
}

const operations = Object.entries(paths).flatMap(([path, item]) => publicOperations(path, item));

function target(value: unknown): Readonly<Record<string, unknown>> {
  const node = record(value);
  const ref = node["$ref"];
  if (typeof ref !== "string") {
    return node;
  }
  let found: unknown = spec;
  for (const token of ref.replace(/^#\//u, "").split("/")) {
    found = record(found)[token.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return target(found);
}

function joined(value: unknown): Readonly<Record<string, unknown>> {
  const node = target(value);
  const parts = [node, ...listOf(node["allOf"]).map((part) => joined(part))];
  const entries: [string, unknown][] = [
    ...parts.flatMap((part) => Object.entries(part)).filter(([key]) => key !== "allOf"),
    ["properties", Object.fromEntries(parts.flatMap((part) => Object.entries(record(part["properties"]))))],
    ["required", parts.flatMap((part) => listOf(part["required"]))],
  ];
  return Object.fromEntries(entries);
}

function plainExample(node: Readonly<Record<string, unknown>>): unknown {
  if ("const" in node) {
    return node["const"];
  }
  const values = node["enum"];
  if (isList(values)) {
    return values[0];
  }
  const type: unknown = [node["type"]].flat()[0];
  if (typeof type === "string" && Object.hasOwn(SAMPLES, type)) {
    return SAMPLES[type];
  }
  const needed = listOf(node["required"]);
  return Object.fromEntries(
    Object.entries(record(node["properties"]))
      .filter(([name]) => needed.includes(name))
      .map(([name, property]) => [name, example(property)]),
  );
}

function example(value: unknown): unknown {
  const node = joined(value);
  const variants = [...listOf(node["oneOf"]), ...listOf(node["anyOf"])];
  if (variants.length > NONE) {
    const rest = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "oneOf" && key !== "anyOf"));
    return example({ allOf: [rest, variants[0]] });
  }
  return plainExample(node);
}

function documented(responses: unknown): unknown {
  const media = Object.entries(record(responses))
    .filter(([code]) => code.startsWith("2"))
    .map(([, success]) => record(target(success)["content"]))
    .find((content) => "application/json" in content);
  return example(record(record(media)["application/json"])["schema"]);
}

function enumOf(name: string): string[] {
  return listOf(record(schemas[name])["enum"]).filter((value) => typeof value === "string");
}

const eventTypes = [...enumOf("EventType"), ...enumOf("PostEventType")];

function required(fields: Readonly<Record<string, Field>>): Record<string, Value> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, field]) => !field.optional)
      .map(([name, field]): [string, Value] => [name, sample(field.shape)]),
  );
}

function emptySample(shape: Empty): Value {
  if ("union" in shape) {
    return sample(shape.union[0] ?? "null");
  }
  if ("array" in shape) {
    return [];
  }
  return {};
}

function sample(shape: Shape): Value {
  if (typeof shape === "string") {
    return PRIMITIVE_SAMPLES[shape];
  }
  if ("ref" in shape) {
    return sample(schema(shape.ref));
  }
  if ("literal" in shape) {
    return shape.literal;
  }
  if ("object" in shape) {
    return required(shape.object);
  }
  return emptySample(shape);
}

function answer(id: string, responses: unknown): Expected {
  const kind = find(id).response;
  if (kind === "bytes") {
    return { response: new Response("abc"), result: "abc" };
  }
  if (kind === "events") {
    const response = new Response('id: 1\nevent: tweet.new\ndata: {"id":"1"}\n\n');
    return { response, result: [{ data: { id: "1" }, event: "tweet.new", id: "1" }] };
  }
  if (kind === "none") {
    return { response: new Response(null, { status: 202 }), result: null };
  }
  const result = documented(responses);
  return { response: Response.json(result), result };
}

function plain(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value);
  }
  return value;
}

function wirePath(path: string, args: Readonly<Record<string, unknown>>): string {
  return path.replaceAll(/\{(?<name>[^}]+)\}/gu, (_match, name: string) =>
    encodeURIComponent(JSON.stringify(args[name]).replaceAll('"', "")),
  );
}

async function signedPost(body: string): Promise<RequestInit> {
  const signed = await sign(body);
  return { body: signed.body, headers: signed.headers, method: "POST" };
}

describe("every public operation in openapi.json", () => {
  it("the spec lists 190 public operations", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(operations).toHaveLength(PUBLIC_OPERATIONS);
  });

  it.each(operations)(
    "$id is a component action that calls $method $path",
    { timeout: 5000 },
    async ({ id, method, path, responses }) => {
      expect.hasAssertions();
      const convex = componentTest();
      const expected = answer(id, responses);
      const recorded = stubFetch(() => expected.response);
      const args = required(find(id).args);
      const reference = makeFunctionReference<"action", Record<string, Value>, Value>(`operations:${id}`);
      const result = await convex.action(reference, args);
      expect(plain(result)).toStrictEqual(expected.result);
      expect(
        recorded.map((sent) => [`${sent.method} ${sent.url.pathname}`, sent.headers.get("x-api-key")]),
      ).toStrictEqual([[`${method} ${wirePath(path, args)}`, "xq_test"]]);
    },
  );
});

describe("every event type in openapi.json", () => {
  it("the spec lists 40 event types", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(eventTypes).toHaveLength(EVENT_TYPES);
  });

  it.each(eventTypes)("the receiver stores a signed %s delivery once", { timeout: 5000 }, async (eventType) => {
    expect.hasAssertions();
    const convex = componentTest();
    const { url } = await convex.mutation(api.webhooks.add, { secret: SECRET });
    const path = new URL(url).pathname.replace("/xquik", "");
    const first = await convex.fetch(path, await signedPost(delivery(eventType, "9001")));
    await expect(first.text()).resolves.toBe("stored");
    const retry = await convex.fetch(path, await signedPost(delivery(eventType, "9001")));
    await expect(retry.text()).resolves.toBe("duplicate");
    await expect(convex.query(api.events.get, { streamEventId: "9001" })).resolves.toMatchObject({
      eventType,
      monitorId: "10",
      streamEventId: "9001",
    });
  });

  it("the receiver answers the webhook.test alert", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const { url } = await convex.mutation(api.webhooks.add, { secret: SECRET });
    const response = await convex.fetch(new URL(url).pathname.replace("/xquik", ""), await signedPost(TEST_ALERT));
    expect({ status: response.status, text: await response.text() }).toStrictEqual({ status: 200, text: "test" });
  });
});
