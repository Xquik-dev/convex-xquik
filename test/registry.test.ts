import { bodyRegistry, json, post, spec } from "./registry-specs.ts";
import { describe, expect, it } from "vitest";
import { eventTypes, operationsModule, readRegistry, registryJson } from "#scripts/registry.ts";
import { parseRegistry } from "#src/component/shape.ts";

interface Generated {
  readonly ids: readonly string[];
  readonly operations: readonly string[];
}

const PUBLIC_OPERATIONS = 190;
const NOT_AN_EVENT = 1;

const KEYED_SPEC = {
  components: { parameters: { Limit: { in: "query", name: "limit", schema: { type: ["integer", "null"] } } } },
  paths: {
    "/a/{id}": {
      delete: { operationId: "dashboardOnly", responses: {}, security: [{ cookieSession: [] }] },
      get: {
        operationId: "getA",
        parameters: [
          { in: "header", name: "Idempotency-Key", schema: { type: "string" } },
          { in: "cookie", name: "session", schema: { type: "string" } },
          { in: "query", schema: { type: "string" } },
          { in: "query", name: "pageSize", schema: { type: "integer" } },
          { $ref: "#/components/parameters/Limit" },
        ],
        responses: { 200: { content: { "application/octet-stream": {} } } },
      },
      parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
      put: { responses: {}, security: [{}] },
    },
    "/open": {
      get: { operationId: "open", responses: { 200: { content: { "text/event-stream": {} } } }, security: [{}] },
    },
  },
  security: [{ apiKey: [] }],
};

const KEYED_OPERATIONS = {
  getA: {
    args: {
      id: { optional: false, shape: "string" },
      idempotencyKey: { optional: true, shape: "string" },
      limit: { optional: true, shape: { union: ["number", "null"] } },
      pageSize: { optional: true, shape: "number" },
    },
    body: null,
    method: "GET",
    params: [
      { in: "path", name: "id", wire: "id" },
      { in: "header", name: "idempotencyKey", wire: "Idempotency-Key" },
      { in: "query", name: "pageSize", wire: "pageSize" },
      { in: "query", name: "limit", wire: "limit" },
    ],
    path: "/a/{id}",
    response: "bytes",
    result: "bytes",
  },
  open: {
    args: {},
    body: null,
    method: "GET",
    params: [],
    path: "/open",
    response: "events",
    result: {
      array: {
        object: {
          data: { optional: false, shape: "any" },
          event: { optional: true, shape: "string" },
          id: { optional: true, shape: "string" },
        },
      },
    },
  },
};

const LOOP_CYCLE = "openapi.json has the reference cycle #/components/schemas/Loop > #/components/schemas/Loop.";
const LOOP_SCHEMAS = { Done: { type: "string" }, Loop: { $ref: "#/components/schemas/Loop" } };
const NODE_SCHEMAS = { Node: { properties: { next: { $ref: "#/components/schemas/Node" } } } };
const DONE_THEN_LOOP = { done: { $ref: "#/components/schemas/Done" }, loop: { $ref: "#/components/schemas/Loop" } };

async function generate(): Promise<Generated> {
  const registry: unknown = JSON.parse(await registryJson());
  return {
    ids: Object.keys(parseRegistry(registry).operations),
    operations: operationsModule().split("\n"),
  };
}

function ok(schema: unknown): unknown {
  return { content: { "application/json": { schema } } };
}

function schemaRef(name: string): unknown {
  return ok({ $ref: `#/components/schemas/${name}` });
}

describe("the generator", () => {
  it("writes the registry and 1 action export per public operation", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const { ids, operations } = await generate();
    const names = ids.map((id) => `  ${id},`);
    expect(ids).toHaveLength(PUBLIC_OPERATIONS);
    expect(operations).toStrictEqual([
      'import { operations } from "./operation.js";',
      "",
      "export const {",
      ...names,
      "} = operations();",
      "",
    ]);
  });

  it("keeps only API key operations and maps headers to camelCase arguments", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const registry = readRegistry(KEYED_SPEC);
    expect(registry.schemas).toStrictEqual({});
    expect(registry.operations).toStrictEqual(KEYED_OPERATIONS);
  });

  it("orders operations by ID", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const registry = readRegistry(
      spec({
        "/a": { get: { operationId: "alpha", responses: {} } },
        "/b": { get: { operationId: "zeta", responses: {} } },
      }),
    );
    expect(Object.keys(registry.operations)).toStrictEqual(["alpha", "zeta"]);
  });
});

describe("the generated results", () => {
  it("types each result as the union of its success responses", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const registry = readRegistry({
      components: {
        responses: { One: ok({ type: "number" }) },
        schemas: { Alpha: { type: "number" }, Beta: { type: "null" }, Zeta: { type: "string" } },
      },
      paths: {
        "/a": {
          get: {
            operationId: "both",
            responses: { 200: schemaRef("Zeta"), 202: ok({ type: "boolean" }), 400: schemaRef("Beta") },
          },
        },
        "/b": { get: { operationId: "maybe", responses: { 200: { $ref: "#/components/responses/One" }, 204: {} } } },
        "/c": { get: { operationId: "same", responses: { 200: schemaRef("Alpha"), 201: schemaRef("Alpha") } } },
      },
      security: [{ apiKey: [] }],
    });
    expect(Object.values(registry.operations).map((operation) => [operation.response, operation.result])).toStrictEqual(
      [
        ["json", { union: [{ ref: "Zeta" }, "boolean"] }],
        ["json", { union: ["number", "null"] }],
        ["json", { ref: "Alpha" }],
      ],
    );
    expect(Object.entries(registry.schemas)).toStrictEqual([
      ["Alpha", "number"],
      ["Zeta", "string"],
    ]);
  });

  it("reads every event type", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const events = spec(
      {},
      { EventType: { enum: ["tweet.new"] }, PostEventType: { enum: ["post.edited", NOT_AN_EVENT] } },
    );
    expect(eventTypes(events)).toStrictEqual(["tweet.new", "post.edited"]);
    expect(eventTypes(null)).toStrictEqual([]);
  });
});

describe("the generator errors", () => {
  it("names each schema it cannot turn into arguments", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    expect(() => bodyRegistry({ type: "array" })).toThrow('make has {"array":"any"} where it needs an object.');
    expect(() => bodyRegistry({ type: "string" })).toThrow('make has "string" where it needs an object.');
    expect(() => bodyRegistry({ enum: [{}] })).toThrow("the enum value {}");
    expect(() => bodyRegistry({ $ref: "#/components/schemas/Missing" })).toThrow("broken reference");
  });

  it("names each reference cycle and each argument clash", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const clash = post(json({ properties: { id: { type: "string" } } }), { 201: {} }, [
      { in: "query", name: "id", schema: { type: "string" } },
    ]);
    expect(() => bodyRegistry({ allOf: [{ $ref: "#/components/schemas/Loop" }] }, LOOP_SCHEMAS)).toThrow(LOOP_CYCLE);
    expect(() => bodyRegistry({ $ref: "#/components/schemas/Node" }, NODE_SCHEMAS)).toThrow(
      "openapi.json has the reference cycle #/components/schemas/Node > #/components/schemas/Node.",
    );
    expect(() => bodyRegistry({ $ref: "#/components/schemas/Loop" }, LOOP_SCHEMAS)).toThrow(LOOP_CYCLE);
    expect(() => readRegistry(spec(clash))).toThrow("make has a parameter and a body field both named id.");
    expect(() => bodyRegistry({ properties: DONE_THEN_LOOP }, LOOP_SCHEMAS)).toThrow(LOOP_CYCLE);
  });
});
