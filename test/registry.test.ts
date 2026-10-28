import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { eventTypes, readRegistry, writeGenerated } from "../scripts/registry.js";
import { isShape, parseRegistry } from "../src/component/shape.js";

const root = new URL("..", import.meta.url).pathname;

function spec(paths: Record<string, unknown>, schemas: Record<string, unknown> = {}): unknown {
  return { security: [{ apiKey: [] }], paths, components: { schemas } };
}

function post(requestBody: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { "/x": { post: { operationId: "make", requestBody, responses: { 201: {} }, ...extra } } };
}

function json(schema: unknown, required = true): unknown {
  return { required, content: { "application/json": { schema } } };
}

describe("the generator", () => {
  test("writes the registry and 1 action export per public operation", () => {
    const work = mkdtempSync(join(tmpdir(), "convex-xquik-"));
    try {
      mkdirSync(join(work, "src/component"), { recursive: true });
      copyFileSync(join(root, "openapi.json"), join(work, "openapi.json"));
      writeGenerated(work);
      const registry: unknown = JSON.parse(readFileSync(join(work, "src/component/registry.json"), "utf8"));
      const ids = Object.keys(parseRegistry(registry));
      const operations = readFileSync(join(work, "src/component/operations.ts"), "utf8").split("\n");
      expect(ids).toHaveLength(190);
      expect(operations).toEqual([
        'import { operation } from "./operation.js";',
        "",
        ...ids.map((id) => `export const ${id} = operation("${id}");`),
        "",
      ]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("keeps only API key operations and maps headers to camelCase arguments", () => {
    const registry = readRegistry({
      security: [{ apiKey: [] }],
      paths: {
        "/a/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          get: {
            operationId: "getA",
            parameters: [
              { name: "Idempotency-Key", in: "header", schema: { type: "string" } },
              { name: "session", in: "cookie", schema: { type: "string" } },
              { in: "query", schema: { type: "string" } },
              { name: "pageSize", in: "query", schema: { type: "integer" } },
              { $ref: "#/components/parameters/Limit" },
            ],
            responses: { 200: { content: { "application/octet-stream": {} } } },
          },
          delete: { operationId: "dashboardOnly", security: [{ cookieSession: [] }], responses: {} },
          put: { security: [{}], responses: {} },
        },
        "/open": {
          get: { operationId: "open", security: [{}], responses: { 200: { content: { "text/event-stream": {} } } } },
        },
      },
      components: { parameters: { Limit: { name: "limit", in: "query", schema: { type: ["integer", "null"] } } } },
    });
    expect(registry).toEqual({
      getA: {
        method: "GET",
        path: "/a/{id}",
        params: [
          { name: "id", in: "path", wire: "id" },
          { name: "idempotencyKey", in: "header", wire: "Idempotency-Key" },
          { name: "pageSize", in: "query", wire: "pageSize" },
          { name: "limit", in: "query", wire: "limit" },
        ],
        body: null,
        response: "bytes",
        args: {
          id: { shape: "string", optional: false },
          idempotencyKey: { shape: "string", optional: true },
          pageSize: { shape: "number", optional: true },
          limit: { shape: { union: ["number", "null"] }, optional: true },
        },
      },
      open: { method: "GET", path: "/open", params: [], body: null, response: "events", args: {} },
    });
  });

  test("turns schemas into shapes", () => {
    const registry = readRegistry(
      spec(
        post(
          json({
            type: "object",
            required: ["kind"],
            properties: {
              kind: { const: "a" },
              level: { enum: [1, "two", null] },
              tags: { type: "array", items: { $ref: "#/components/schemas/Tag~0x" } },
              raw: { type: "array" },
              map: { type: "object", additionalProperties: { type: "boolean" } },
              free: { type: "object" },
              both: {
                allOf: [
                  { properties: { a: { type: "string" } }, required: ["a"] },
                  { properties: { a: { type: "string" }, b: { type: "number" } } },
                ],
              },
              either: { anyOf: [{ type: "string" }, { type: "string" }, {}] },
              nested: { properties: { x: { type: "boolean" } } },
              choice: { anyOf: [{ enum: ["a", "b"] }, { type: "number" }] },
              flag: { const: true },
              none: { enum: [] },
              mixed: { type: ["string", 5] },
            },
          }),
          { responses: { 200: { content: { "application/json": {} } } } },
        ),
        { "Tag~x": { type: "string" } },
      ),
    );
    expect(registry["make"]?.response).toBe("json");
    expect(registry["make"]?.args).toEqual({
      kind: { shape: { literal: "a" }, optional: false },
      level: { shape: { union: [{ literal: 1 }, { literal: "two" }, "null"] }, optional: true },
      tags: { shape: { array: "string" }, optional: true },
      raw: { shape: { array: "any" }, optional: true },
      map: { shape: { record: "boolean" }, optional: true },
      free: { shape: "any", optional: true },
      both: {
        shape: { object: { a: { shape: "string", optional: false }, b: { shape: "number", optional: true } } },
        optional: true,
      },
      either: { shape: "any", optional: true },
      nested: { shape: { object: { x: { shape: "boolean", optional: true } } }, optional: true },
      choice: { shape: { union: [{ literal: "a" }, { literal: "b" }, "number"] }, optional: true },
      flag: { shape: { literal: true }, optional: true },
      none: { shape: { union: [] }, optional: true },
      mixed: { shape: "string", optional: true },
    });
  });

  test("keeps a field required only where every oneOf body requires it", () => {
    const registry = readRegistry(
      spec(
        post(
          json({
            oneOf: [
              {
                properties: { step: { const: "a" }, text: { type: "string" }, note: { type: "string" } },
                required: ["step", "text", "note"],
              },
              { properties: { step: { const: "b" }, note: { type: "string" } }, required: ["step"] },
            ],
          }),
          { responses: { 204: {}, 400: { content: { "application/json": {} } } } },
        ),
      ),
    );
    expect(registry["make"]).toMatchObject({
      response: "none",
      args: {
        step: { shape: { union: [{ literal: "a" }, { literal: "b" }] }, optional: false },
        text: { shape: "string", optional: true },
        note: { shape: "string", optional: true },
      },
    });
  });

  test("orders operations by ID", () => {
    const registry = readRegistry(
      spec({
        "/b": { get: { operationId: "zeta", responses: {} } },
        "/a": { get: { operationId: "alpha", responses: {} } },
      }),
    );
    expect(Object.keys(registry)).toEqual(["alpha", "zeta"]);
  });

  test("merges oneOf bodies into lenient arguments and makes an optional body optional", () => {
    const registry = readRegistry(
      spec(
        post(
          json(
            {
              oneOf: [
                { properties: { step: { const: "a" }, text: { type: "string" } }, required: ["step", "text"] },
                { properties: { step: { const: "b" } }, required: ["step"] },
              ],
            },
            false,
          ),
        ),
      ),
    );
    expect(registry["make"]).toMatchObject({
      body: ["step", "text"],
      response: "none",
      args: {
        step: { shape: { union: [{ literal: "a" }, { literal: "b" }] }, optional: true },
        text: { shape: "string", optional: true },
      },
    });
  });

  test("names each spec problem it cannot turn into arguments", () => {
    expect(() => readRegistry(spec(post(json({ type: "array" }))))).toThrow(
      'make has {"array":"any"} where it needs an object.',
    );
    expect(() => readRegistry(spec(post(json({ type: "string" }))))).toThrow(
      'make has "string" where it needs an object.',
    );
    expect(() => readRegistry(spec(post(json({ allOf: [{ type: "string" }] }))))).toThrow('An allOf has "string"');
    expect(() => readRegistry(spec(post(json({ enum: [{}] }))))).toThrow("the enum value {}");
    expect(() => readRegistry(spec(post(json({ $ref: "#/components/schemas/Missing" }))))).toThrow("broken reference");
    expect(() =>
      readRegistry(spec(post(json({ $ref: "#/components/schemas/A" })), { A: { $ref: "#/components/schemas/A" } })),
    ).toThrow("openapi.json has the reference cycle #/components/schemas/A > #/components/schemas/A.");
    const clash = post(json({ properties: { id: { type: "string" } } }), {
      parameters: [{ name: "id", in: "query", schema: { type: "string" } }],
    });
    expect(() => readRegistry(spec(clash))).toThrow("make has a parameter and a body field both named id.");
  });

  test("reads every event type", () => {
    expect(
      eventTypes(spec({}, { EventType: { enum: ["tweet.new"] }, PostEventType: { enum: ["post.edited", 1] } })),
    ).toEqual(["tweet.new", "post.edited"]);
    expect(eventTypes(null)).toEqual([]);
  });
});

describe("the registry parser", () => {
  test("accepts every shape and rejects anything else", () => {
    for (const shape of [
      "string",
      "any",
      { literal: true },
      { literal: 1 },
      { array: "null" },
      { record: "number" },
      { union: ["string", { literal: 1 }] },
    ]) {
      expect(isShape(shape)).toBe(true);
    }
    const rejected = [
      "date",
      { literal: {} },
      { array: "x" },
      { object: { a: { shape: "string" } } },
      { union: "x" },
      { union: ["string", "date"] },
      { tuple: ["string"] },
      { a: 1, b: 2 },
      { literal: "x", array: "string" },
      {},
      [],
      1,
      null,
    ];
    for (const shape of rejected) {
      expect(isShape(shape)).toBe(false);
    }
    expect(isShape({ object: { a: { shape: "string", optional: false } } })).toBe(true);
  });

  test("rejects a malformed registry", () => {
    const good = {
      method: "GET",
      path: "/",
      params: [{ name: "a", in: "query", wire: "a" }],
      body: ["x"],
      response: "json",
      args: {},
    };
    expect(parseRegistry({ a: good })).toEqual({ a: good });
    for (const bad of [
      null,
      { a: null },
      { a: good, b: { ...good, response: "xml" } },
      { a: { ...good, method: 1 } },
      { a: { ...good, params: [{ name: "a", in: "cookie", wire: "a" }] } },
      { a: { ...good, params: [{ name: 1, in: "query", wire: "a" }] } },
      { a: { ...good, params: [{ name: "a", in: "query", wire: 1 }] } },
      { a: { ...good, body: [1] } },
      { a: { ...good, body: ["x", 1] } },
      { a: { ...good, response: "xml" } },
      { a: { ...good, args: { x: { shape: "date", optional: true } } } },
      { a: { ...good, path: 1 } },
    ]) {
      expect(() => parseRegistry(bad)).toThrow("The operation registry is malformed. Run npm run generate.");
    }
  });
});
