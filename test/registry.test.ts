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

function objectSpec(body: unknown): unknown {
  return {
    security: [{ apiKey: [] }],
    paths: post(json(body)),
    components: {
      flags: { Flag: { type: "boolean" } },
      schemas: {
        Left: {
          type: "object",
          required: ["shared", "side"],
          properties: {
            shared: { type: "string" },
            flag: { $ref: "#/components/flags/Flag" },
            side: { const: "left" },
          },
        },
        Right: {
          type: "object",
          required: ["shared", "side"],
          properties: { shared: { $ref: "#/components/schemas/Left/properties/shared" }, side: { const: "right" } },
        },
      },
    },
  };
}

describe("the generator", () => {
  test("writes the registry and 1 action export per public operation", () => {
    const work = mkdtempSync(join(tmpdir(), "xquik-convex-"));
    try {
      mkdirSync(join(work, "src/component"), { recursive: true });
      copyFileSync(join(root, "openapi.json"), join(work, "openapi.json"));
      writeGenerated(work);
      const registry: unknown = JSON.parse(readFileSync(join(work, "src/component/registry.json"), "utf8"));
      const ids = Object.keys(parseRegistry(registry).operations);
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
    expect(registry.schemas).toEqual({});
    expect(registry.operations).toEqual({
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
        result: "bytes",
        args: {
          id: { shape: "string", optional: false },
          idempotencyKey: { shape: "string", optional: true },
          pageSize: { shape: "number", optional: true },
          limit: { shape: { union: ["number", "null"] }, optional: true },
        },
      },
      open: {
        method: "GET",
        path: "/open",
        params: [],
        body: null,
        response: "events",
        result: {
          array: {
            object: {
              id: { shape: "string", optional: true },
              event: { shape: "string", optional: true },
              data: { shape: "any", optional: false },
            },
          },
        },
        args: {},
      },
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
    expect(registry.operations["make"]).toMatchObject({ response: "json", result: "any" });
    expect(registry.schemas).toEqual({ "Tag~0x": "string" });
    expect(registry.operations["make"]?.args).toEqual({
      kind: { shape: { literal: "a" }, optional: false },
      level: { shape: { union: [{ literal: 1 }, { literal: "two" }, "null"] }, optional: true },
      tags: { shape: { array: { ref: "Tag~0x" } }, optional: true },
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
    expect(registry.operations["make"]).toMatchObject({
      response: "none",
      result: "null",
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
    expect(Object.keys(registry.operations)).toEqual(["alpha", "zeta"]);
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
    expect(registry.operations["make"]).toMatchObject({
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
    expect(() =>
      readRegistry(
        spec(post(json({ allOf: [{ $ref: "#/components/schemas/B" }] })), { B: { $ref: "#/components/schemas/B" } }),
      ),
    ).toThrow("openapi.json has the reference cycle #/components/schemas/B > #/components/schemas/B.");
    expect(() =>
      readRegistry(
        spec(post(json({ $ref: "#/components/schemas/Node" })), {
          Node: { properties: { next: { $ref: "#/components/schemas/Node" } } },
        }),
      ),
    ).toThrow("openapi.json has the reference cycle #/components/schemas/Node > #/components/schemas/Node.");
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

  test("types each result as the union of its success responses", () => {
    const ok = (schema: unknown): unknown => ({ content: { "application/json": { schema } } });
    const ref = (name: string): unknown => ok({ $ref: `#/components/schemas/${name}` });
    const registry = readRegistry({
      security: [{ apiKey: [] }],
      paths: {
        "/a": {
          get: { operationId: "both", responses: { 200: ref("Z"), 202: ok({ type: "boolean" }), 400: ref("B") } },
        },
        "/b": { get: { operationId: "maybe", responses: { 200: { $ref: "#/components/responses/One" }, 204: {} } } },
        "/c": { get: { operationId: "same", responses: { 200: ref("A"), 201: ref("A") } } },
      },
      components: {
        schemas: { A: { type: "number" }, B: { type: "null" }, Z: { type: "string" } },
        responses: { One: ok({ type: "number" }) },
      },
    });
    expect(Object.values(registry.operations).map((operation) => [operation.response, operation.result])).toEqual([
      ["json", { union: [{ ref: "Z" }, "boolean"] }],
      ["json", { union: ["number", "null"] }],
      ["json", { ref: "A" }],
    ]);
    expect(Object.entries(registry.schemas)).toEqual([
      ["A", "number"],
      ["Z", "string"],
    ]);
  });

  test("merges allOf parts and a shared oneOf base at the node level", () => {
    const wallet = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, key: { type: "string" }, owner: { $ref: "#/components/schemas/Owner" } },
    };
    const properties = {
      wallet: {
        allOf: [
          { $ref: "#/components/schemas/Wallet" },
          { type: "object", required: ["key"] },
          { not: { required: ["secret"] } },
        ],
      },
      answer: {
        type: "object",
        required: ["meta"],
        properties: { meta: { type: "string" }, results: { type: "array", items: { type: "number" } } },
        oneOf: [{ required: ["results"], properties: { results: { type: "array" } } }, { required: ["text"] }],
      },
      either: { description: "Either one.", oneOf: [{ $ref: "#/components/schemas/Wallet" }, { type: "null" }] },
      labels: { allOf: [{ type: "object", additionalProperties: { type: "string" } }, { description: "Labels." }] },
      keyed: { required: ["kind"], oneOf: [{ properties: { kind: { const: "a" } } }] },
      named: { properties: { kind: { const: "b" } }, oneOf: [{ required: ["kind"] }] },
    };
    const registry = readRegistry(spec(post(json({ properties })), { Wallet: wallet, Owner: { type: "string" } }));
    const string = { shape: "string", optional: false };
    expect(registry.operations["make"]?.args).toEqual({
      wallet: {
        shape: { object: { id: string, key: string, owner: { shape: { ref: "Owner" }, optional: true } } },
        optional: true,
      },
      answer: {
        shape: {
          union: [
            { object: { meta: string, results: { shape: { array: "number" }, optional: false } } },
            { object: { meta: string, results: { shape: { array: "number" }, optional: true } } },
          ],
        },
        optional: true,
      },
      either: { shape: { union: [{ ref: "Wallet" }, "null"] }, optional: true },
      labels: { shape: { record: "string" }, optional: true },
      keyed: { shape: { object: { kind: { shape: { literal: "a" }, optional: false } } }, optional: true },
      named: { shape: { object: { kind: { shape: { literal: "b" }, optional: false } } }, optional: true },
    });
  });

  test("names a JSON-LD key without its @ and keeps the wire name", () => {
    const doc = {
      type: "object",
      required: ["@id"],
      properties: { "@id": { type: "string" }, "@type": { const: "A" }, "mail@to": { type: "string" } },
    };
    const body = json({ properties: { doc: { $ref: "#/components/schemas/Doc" } } });
    const registry = readRegistry(spec(post(body), { Doc: doc }));
    expect(registry.schemas["Doc"]).toEqual({
      object: {
        id: { shape: "string", optional: false, wire: "@id" },
        type: { shape: { literal: "A" }, optional: true, wire: "@type" },
        "mail@to": { shape: "string", optional: true },
      },
    });
  });

  test("stores each named schema once, keeps deep pointers by path and inlines other references", () => {
    const registry = readRegistry(
      objectSpec({ oneOf: [{ $ref: "#/components/schemas/Left" }, { $ref: "#/components/schemas/Right" }] }),
    );
    expect(registry.operations["make"]?.args).toEqual({
      shared: { shape: { union: ["string", { ref: "Left/properties/shared" }] }, optional: false },
      flag: { shape: "boolean", optional: true },
      side: { shape: { union: [{ literal: "left" }, { literal: "right" }] }, optional: false },
    });
    expect(registry.schemas).toEqual({
      Left: {
        object: {
          shared: { shape: "string", optional: false },
          flag: { shape: "boolean", optional: true },
          side: { shape: { literal: "left" }, optional: false },
        },
      },
      "Left/properties/shared": "string",
      Right: {
        object: {
          shared: { shape: { ref: "Left/properties/shared" }, optional: false },
          side: { shape: { literal: "right" }, optional: false },
        },
      },
    });
  });

  test("builds each named schema once however many paths share it", () => {
    const chain = Object.fromEntries(
      Array.from({ length: 30 }, (_item, index) => {
        const next = { $ref: `#/components/schemas/S${String(index + 1)}` };
        return [`S${String(index)}`, { type: "object", properties: { a: next, b: next } }];
      }),
    );
    const schemas = { ...chain, S30: { type: "string" } };
    const registry = readRegistry(spec(post(json({ $ref: "#/components/schemas/S0" })), schemas));
    expect(Object.keys(registry.schemas)).toHaveLength(31);
    expect(registry.schemas["S29"]).toEqual({
      object: { a: { shape: { ref: "S30" }, optional: true }, b: { shape: { ref: "S30" }, optional: true } },
    });
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
      "bytes",
      { ref: "SearchTweet" },
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
      { ref: 1 },
      { object: { a: { shape: "string", optional: false, wire: 1 } } },
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
    expect(isShape({ object: { id: { shape: "string", optional: false, wire: "@id" } } })).toBe(true);
  });

  test("rejects a malformed registry", () => {
    const good = {
      method: "GET",
      path: "/",
      params: [{ name: "a", in: "query", wire: "a" }],
      body: ["x"],
      response: "json",
      args: {},
      result: { ref: "A" },
    };
    const registry = { operations: { a: good }, schemas: { A: "string" } };
    expect(parseRegistry(registry)).toEqual(registry);
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
      { a: { ...good, result: "date" } },
    ]) {
      expect(() => parseRegistry({ operations: bad, schemas: {} })).toThrow(
        "The operation registry is malformed. Run npm run generate.",
      );
    }
    for (const bad of [
      null,
      { operations: {} },
      { schemas: {} },
      { operations: {}, schemas: { A: "string", B: "date" } },
    ]) {
      expect(() => parseRegistry(bad)).toThrow("The operation registry is malformed. Run npm run generate.");
    }
  });
});
