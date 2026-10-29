import { describe, expect, it } from "vitest";
import { isShape, parseRegistry } from "#src/component/shape.ts";

const NOT_A_SHAPE = 1;
const MALFORMED = "The operation registry is malformed. Run npm run generate.";

const ACCEPTED = [
  "string",
  "any",
  "bytes",
  { ref: "SearchTweet" },
  { literal: true },
  { literal: 1 },
  { array: "null" },
  { record: "number" },
  { union: ["string", { literal: 1 }] },
];

const REJECTED = [
  "date",
  { literal: {} },
  { array: "x" },
  { object: { field: { shape: "string" } } },
  { union: "x" },
  { union: ["string", "date"] },
  { ref: 1 },
  { object: { field: { optional: false, shape: "string", wire: 1 } } },
  { tuple: ["string"] },
  { alpha: 1, beta: 2 },
  { array: "string", literal: "x" },
  {},
  [],
  NOT_A_SHAPE,
  null,
];

const GOOD = {
  args: {},
  body: ["x"],
  method: "GET",
  params: [{ in: "query", name: "make", wire: "make" }],
  path: "/",
  response: "json",
  result: { ref: "Alpha" },
};

function variant(name: string, value: unknown): unknown {
  return Object.fromEntries<unknown>([...Object.entries(GOOD), [name, value]]);
}

function changed(name: string, value: unknown): unknown {
  return { make: variant(name, value) };
}

const BAD_OPERATIONS = [
  null,
  { make: null },
  { make: GOOD, other: variant("response", "xml") },
  changed("method", NOT_A_SHAPE),
  changed("params", [{ in: "cookie", name: "make", wire: "make" }]),
  changed("params", [{ in: "query", name: NOT_A_SHAPE, wire: "make" }]),
  changed("params", [{ in: "query", name: "make", wire: NOT_A_SHAPE }]),
  changed("body", [NOT_A_SHAPE]),
  changed("body", ["x", NOT_A_SHAPE]),
  changed("response", "xml"),
  changed("args", { field: { optional: true, shape: "date" } }),
  changed("path", NOT_A_SHAPE),
  changed("result", "date"),
];

const BAD_REGISTRIES = [null, { operations: {} }, { schemas: {} }];

describe("the registry parser", () => {
  it("accepts every shape and rejects anything else", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    for (const shape of ACCEPTED) {
      expect(isShape(shape)).toBe(true);
    }
    for (const shape of REJECTED) {
      expect(isShape(shape)).toBe(false);
    }
    expect(isShape({ object: { field: { optional: false, shape: "string" } } })).toBe(true);
    expect(isShape({ object: { id: { optional: false, shape: "string", wire: "@id" } } })).toBe(true);
  });

  it("rejects a malformed registry", { timeout: 10_000 }, () => {
    expect.hasAssertions();
    const registry = { operations: { make: GOOD }, schemas: { Alpha: "string" } };
    expect(parseRegistry(registry)).toStrictEqual(registry);
    for (const bad of BAD_OPERATIONS) {
      expect(() => parseRegistry({ operations: bad, schemas: {} })).toThrow(MALFORMED);
    }
    for (const bad of BAD_REGISTRIES) {
      expect(() => parseRegistry(bad)).toThrow(MALFORMED);
    }
    expect(() => parseRegistry({ operations: {}, schemas: { Alpha: "string", Beta: "date" } })).toThrow(MALFORMED);
  });
});
