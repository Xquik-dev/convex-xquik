import { argument, events, find, matches, parse, project, schema, validator } from "#src/component/request.ts";
import { ConvexError, v } from "convex/values";
import { describe, expect, it } from "vitest";
import type { Field, Shape } from "#src/component/shape.ts";
import { toValue } from "#src/component/values.ts";

const unset: { readonly value?: string } = {};

const post: Shape = {
  object: {
    id: { optional: false, shape: "string" },
    kind: { optional: true, shape: { literal: "post" }, wire: "@type" },
  },
};

const cases: { readonly bad: unknown; readonly good: unknown; readonly shape: Shape }[] = [
  { bad: 0, good: null, shape: "null" },
  { bad: [true], good: new Uint8Array().buffer, shape: "bytes" },
  { bad: 1, good: "a", shape: "string" },
  { bad: "1", good: 1, shape: "number" },
  { bad: 0, good: false, shape: "boolean" },
  { bad: "b", good: "a", shape: { literal: "a" } },
  { bad: ["x", true], good: ["x", "y"], shape: { array: "string" } },
  { bad: { 0: "x" }, good: [], shape: { array: "string" } },
  { bad: { first: "1" }, good: { first: 1 }, shape: { record: "number" } },
  { bad: [true], good: {}, shape: { record: "number" } },
  { bad: { kind: "post" }, good: { id: "1" }, shape: post },
  { bad: { id: 1 }, good: { id: "1", kind: "post" }, shape: post },
  { bad: "1", good: { id: "1" }, shape: post },
  { bad: 1, good: null, shape: { union: ["string", "null"] } },
  { bad: 1, good: "abc", shape: { ref: "NextCursor" } },
];

describe("parsing", () => {
  it("events keeps id, event and data and skips comments and blocks without data", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(events(": ping\n\nevent: x\n\nretry: 5\ndata: a\ndata: b\nid: 9\n\nnocolon\n\n")).toStrictEqual([
      { data: "a\nb", id: "9" },
    ]);
    expect(events("data\n\nid\ndata:a b\n\n")).toStrictEqual([{ data: "" }, { data: "a b", id: "" }]);
  });

  it("toValue keeps JSON values and turns anything else into null", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(toValue({ count: 1, list: ["b", true, null, unset.value], run: () => "ignored" })).toStrictEqual({
      count: 1,
      list: ["b", true, null, null],
      run: null,
    });
    expect(parse('{"outer":[{"count":1},{"inner":"z"}]}')).toStrictEqual({ outer: [{ count: 1 }, { inner: "z" }] });
  });

  it("schema names a schema the registry lacks", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(schema("NextCursor")).toBe("string");
    expect(() => schema("Nope")).toThrow("The operation registry has no schema Nope. Run npm run generate.");
  });

  it("argument returns one argument's validator and names a missing one", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(argument(find("getUser"), "id")).toStrictEqual(v.string());
    expect(() => argument(find("getUser"), "nope")).toThrow("GET /api/v1/x/users/{id} has no argument nope.");
  });

  it("find names an unknown operation", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(() => find("nope")).toThrow(ConvexError);
    expect(find("getUser").path).toBe("/api/v1/x/users/{id}");
  });
});

describe(validator, () => {
  it("builds Convex validators from container shapes", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(validator({ union: ["string", { literal: "post" }] })).toStrictEqual(v.union(v.string(), v.literal("post")));
    expect(validator({ record: "boolean" })).toStrictEqual(v.record(v.string(), v.boolean()));
    expect(validator({ array: "null" })).toStrictEqual(v.array(v.null()));
  });

  it("builds Convex validators from objects, primitives and named schemas", { timeout: 5000 }, () => {
    expect.hasAssertions();
    const count = v.optional(v.number());
    expect(validator({ object: { count: { optional: true, shape: "number" } } })).toStrictEqual(v.object({ count }));
    expect(validator("any")).toStrictEqual(v.any());
    expect(validator("bytes")).toStrictEqual(v.bytes());
    expect(validator({ ref: "JobLocation" })).toStrictEqual(v.object({ id: v.string(), name: v.string() }));
  });

  it("builds 1 validator for each named schema", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(validator({ ref: "JobLocation" })).toBe(validator({ ref: "JobLocation" }));
  });
});

describe(project, () => {
  it("keeps documented fields under their Convex names and drops the rest", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(project(post, { "@type": "post", extra: true, id: "1", kind: "x" })).toStrictEqual({
      id: "1",
      kind: "post",
    });
    expect(project({ array: post }, [{ extra: 1, id: "1" }])).toStrictEqual([{ id: "1" }]);
    expect(project({ record: post }, { first: { extra: 1, id: "1" } })).toStrictEqual({ first: { id: "1" } });
  });

  it("keeps named schemas, any and literals as they are", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(project({ ref: "JobLocation" }, { extra: 1, id: "1", name: "Mars" })).toStrictEqual({
      id: "1",
      name: "Mars",
    });
    expect(project("any", { list: ["b", unset.value] })).toStrictEqual({ list: ["b", null] });
    expect(project({ literal: "post" }, "post")).toBe("post");
  });

  it("keeps the matching union member that holds the most data", { timeout: 5000 }, () => {
    expect.hasAssertions();
    const text: Field = { optional: false, shape: "string" };
    const posts: Shape = { union: [{ object: { id: text } }, { object: { id: text, text } }] };
    expect(project(posts, { extra: 1, id: "1", text: "hi" })).toStrictEqual({ id: "1", text: "hi" });
    expect(project(posts, { extra: 1, id: "1" })).toStrictEqual({ id: "1" });
    const either: Shape = {
      union: [
        { object: { alpha: text } },
        { object: { bravo: text } },
        { object: { count: { optional: false, shape: "number" } } },
      ],
    };
    expect(project(either, { alpha: "x", bravo: "y" })).toStrictEqual({ alpha: "x" });
    expect(project(either, { bravo: "y", other: 1 })).toStrictEqual({ bravo: "y" });
    expect(project(either, { other: 1 })).toStrictEqual({ other: 1 });
  });

  it("leaves a value of the wrong kind for the returns validator to reject", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(project({ array: "string" }, { alpha: 1 })).toStrictEqual({ alpha: 1 });
    expect(project({ record: "string" }, ["b"])).toStrictEqual(["b"]);
    expect(project(post, ["b"])).toStrictEqual(["b"]);
    expect(project("string", unset.value)).toBeNull();
  });
});

describe(matches, () => {
  it.each(cases)(
    "tells a matching value from a mismatching one in case %#",
    { timeout: 5000 },
    ({ bad, good, shape }) => {
      expect.hasAssertions();
      expect([matches(shape, good), matches(shape, bad)]).toStrictEqual([true, false]);
    },
  );

  it("accepts anything for any", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(matches("any", unset.value)).toBe(true);
  });
});
