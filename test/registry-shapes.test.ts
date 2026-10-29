import { argsOf, bodyRegistry, json, post, spec } from "./registry-specs.ts";
import { describe, expect, it } from "vitest";
import { readRegistry } from "#scripts/registry.ts";

const LEVEL_NUMBER = 1;
const NOT_A_TYPE = 5;
const CHAIN_LENGTH = 30;
const CHAIN_SCHEMAS = 31;
const NEXT_LINK = 1;

const SHAPES_BODY = {
  properties: {
    both: {
      allOf: [
        { properties: { alpha: { type: "string" } }, required: ["alpha"] },
        { properties: { alpha: { type: "string" }, beta: { type: "number" } } },
      ],
    },
    choice: { anyOf: [{ enum: ["a", "b"] }, { type: "number" }] },
    either: { anyOf: [{ type: "string" }, { type: "string" }, {}] },
    flag: { const: true },
    free: { type: "object" },
    kind: { const: "a" },
    level: { enum: [LEVEL_NUMBER, "two", null] },
    map: { additionalProperties: { type: "boolean" }, type: "object" },
    mixed: { type: ["string", NOT_A_TYPE] },
    nested: { properties: { inner: { type: "boolean" } } },
    none: { enum: [] },
    raw: { type: "array" },
    tags: { items: { $ref: "#/components/schemas/Tag~0x" }, type: "array" },
  },
  required: ["kind"],
  type: "object",
};

const SHAPES_ARGS = {
  both: {
    optional: true,
    shape: { object: { alpha: { optional: false, shape: "string" }, beta: { optional: true, shape: "number" } } },
  },
  choice: { optional: true, shape: { union: [{ literal: "a" }, { literal: "b" }, "number"] } },
  either: { optional: true, shape: "any" },
  flag: { optional: true, shape: { literal: true } },
  free: { optional: true, shape: "any" },
  kind: { optional: false, shape: { literal: "a" } },
  level: { optional: true, shape: { union: [{ literal: LEVEL_NUMBER }, { literal: "two" }, "null"] } },
  map: { optional: true, shape: { record: "boolean" } },
  mixed: { optional: true, shape: "string" },
  nested: { optional: true, shape: { object: { inner: { optional: true, shape: "boolean" } } } },
  none: { optional: true, shape: { union: [] } },
  raw: { optional: true, shape: { array: "any" } },
  tags: { optional: true, shape: { array: { ref: "Tag~0x" } } },
};

const WALLET = {
  properties: { id: { type: "string" }, key: { type: "string" }, owner: { $ref: "#/components/schemas/Owner" } },
  required: ["id"],
  type: "object",
};

const NODE_PROPERTIES = {
  answer: {
    oneOf: [{ properties: { results: { type: "array" } }, required: ["results"] }, { required: ["text"] }],
    properties: { meta: { type: "string" }, results: { items: { type: "number" }, type: "array" } },
    required: ["meta"],
    type: "object",
  },
  either: { description: "Either one.", oneOf: [{ $ref: "#/components/schemas/Wallet" }, { type: "null" }] },
  keyed: { oneOf: [{ properties: { kind: { const: "a" } } }], required: ["kind"] },
  labels: { allOf: [{ additionalProperties: { type: "string" }, type: "object" }, { description: "Labels." }] },
  named: { oneOf: [{ required: ["kind"] }], properties: { kind: { const: "b" } } },
  wallet: {
    allOf: [
      { $ref: "#/components/schemas/Wallet" },
      { required: ["key"], type: "object" },
      { not: { required: ["secret"] } },
    ],
  },
};

const STRING_FIELD = { optional: false, shape: "string" };

const NODE_ARGS = {
  answer: {
    optional: true,
    shape: {
      union: [
        { object: { meta: STRING_FIELD, results: { optional: false, shape: { array: "number" } } } },
        { object: { meta: STRING_FIELD, results: { optional: true, shape: { array: "number" } } } },
      ],
    },
  },
  either: { optional: true, shape: { union: [{ ref: "Wallet" }, "null"] } },
  keyed: { optional: true, shape: { object: { kind: { optional: false, shape: { literal: "a" } } } } },
  labels: { optional: true, shape: { record: "string" } },
  named: { optional: true, shape: { object: { kind: { optional: false, shape: { literal: "b" } } } } },
  wallet: {
    optional: true,
    shape: { object: { id: STRING_FIELD, key: STRING_FIELD, owner: { optional: true, shape: { ref: "Owner" } } } },
  },
};

const SIDES = {
  flags: { Flag: { type: "boolean" } },
  schemas: {
    Left: {
      properties: { flag: { $ref: "#/components/flags/Flag" }, shared: { type: "string" }, side: { const: "left" } },
      required: ["shared", "side"],
      type: "object",
    },
    Right: {
      properties: { shared: { $ref: "#/components/schemas/Left/properties/shared" }, side: { const: "right" } },
      required: ["shared", "side"],
      type: "object",
    },
  },
};

const SIDE_SCHEMAS = {
  Left: {
    object: {
      flag: { optional: true, shape: "boolean" },
      shared: { optional: false, shape: "string" },
      side: { optional: false, shape: { literal: "left" } },
    },
  },
  "Left/properties/shared": "string",
  Right: {
    object: {
      shared: { optional: false, shape: { ref: "Left/properties/shared" } },
      side: { optional: false, shape: { literal: "right" } },
    },
  },
};

function link(index: number): [string, unknown] {
  const next = { $ref: `#/components/schemas/S${String(index + NEXT_LINK)}` };
  return [`S${String(index)}`, { properties: { left: next, right: next }, type: "object" }];
}

const CHAIN = Object.fromEntries<unknown>([
  ...Array.from({ length: CHAIN_LENGTH }, (_item, index) => link(index)),
  ["S30", { type: "string" }],
]);

describe("the schema reader", () => {
  it("turns schemas into shapes", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const paths = post(json(SHAPES_BODY), { 200: { content: { "application/json": {} } } });
    const registry = readRegistry(spec(paths, { "Tag~x": { type: "string" } }));
    expect(registry.operations["make"]).toMatchObject({ response: "json", result: "any" });
    expect(registry.schemas).toStrictEqual({ "Tag~0x": "string" });
    expect(argsOf(registry)).toStrictEqual([SHAPES_ARGS]);
  });

  it("merges allOf parts and a shared oneOf base at the node level", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const registry = bodyRegistry({ properties: NODE_PROPERTIES }, { Owner: { type: "string" }, Wallet: WALLET });
    expect(argsOf(registry)).toStrictEqual([NODE_ARGS]);
  });

  it("merges a property that two allOf parts both declare", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const parts = [{ properties: { mode: { type: "string" } } }, { properties: { mode: { enum: ["fast"] } } }];
    const registry = bodyRegistry({ properties: { both: { allOf: parts } } });
    expect(argsOf(registry)).toStrictEqual([
      { both: { optional: true, shape: { object: { mode: { optional: true, shape: { literal: "fast" } } } } } },
    ]);
  });

  it("names a JSON-LD key without its @ and keeps the wire name", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const doc = {
      properties: { "@id": { type: "string" }, "@type": { const: "A" }, "mail@to": { type: "string" } },
      required: ["@id"],
      type: "object",
    };
    const registry = bodyRegistry({ properties: { doc: { $ref: "#/components/schemas/Doc" } } }, { Doc: doc });
    expect(registry.schemas["Doc"]).toStrictEqual({
      object: {
        id: { optional: false, shape: "string", wire: "@id" },
        "mail@to": { optional: true, shape: "string" },
        type: { optional: true, shape: { literal: "A" }, wire: "@type" },
      },
    });
  });
});

describe("the oneOf reader", () => {
  it("keeps a field required only where every oneOf body requires it", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const body = json({
      oneOf: [
        {
          properties: { note: { type: "string" }, step: { const: "a" }, text: { type: "string" } },
          required: ["step", "text", "note"],
        },
        { properties: { note: { type: "string" }, step: { const: "b" } }, required: ["step"] },
      ],
    });
    const registry = readRegistry(spec(post(body, { 204: {}, 400: { content: { "application/json": {} } } })));
    expect(registry.operations["make"]).toMatchObject({
      args: {
        note: { optional: true, shape: "string" },
        step: { optional: false, shape: { union: [{ literal: "a" }, { literal: "b" }] } },
        text: { optional: true, shape: "string" },
      },
      response: "none",
      result: "null",
    });
  });

  it("merges oneOf bodies into lenient arguments and makes an optional body optional", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const body = json(
      {
        oneOf: [
          { properties: { step: { const: "a" }, text: { type: "string" } }, required: ["step", "text"] },
          { properties: { step: { const: "b" } }, required: ["step"] },
        ],
      },
      false,
    );
    const registry = readRegistry(spec(post(body)));
    expect(registry.operations["make"]).toMatchObject({
      args: {
        step: { optional: true, shape: { union: [{ literal: "a" }, { literal: "b" }] } },
        text: { optional: true, shape: "string" },
      },
      body: ["step", "text"],
      response: "none",
    });
  });
});

describe("the named schema store", () => {
  it(
    "stores each named schema once, keeps deep pointers by path and inlines other references",
    { timeout: 10_000 },
    () => {
      expect.hasAssertions();
      const body = json({ oneOf: [{ $ref: "#/components/schemas/Left" }, { $ref: "#/components/schemas/Right" }] });
      const registry = readRegistry({ components: SIDES, paths: post(body), security: [{ apiKey: [] }] });
      expect(argsOf(registry)).toStrictEqual([
        {
          flag: { optional: true, shape: "boolean" },
          shared: { optional: false, shape: { union: ["string", { ref: "Left/properties/shared" }] } },
          side: { optional: false, shape: { union: [{ literal: "left" }, { literal: "right" }] } },
        },
      ]);
      expect(registry.schemas).toStrictEqual(SIDE_SCHEMAS);
    },
  );

  it("builds each named schema once however many paths share it", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const registry = bodyRegistry({ $ref: "#/components/schemas/S0" }, CHAIN);
    expect(Object.keys(registry.schemas)).toHaveLength(CHAIN_SCHEMAS);
    expect(registry.schemas["S29"]).toStrictEqual({
      object: { left: { optional: true, shape: { ref: "S30" } }, right: { optional: true, shape: { ref: "S30" } } },
    });
  });
});
