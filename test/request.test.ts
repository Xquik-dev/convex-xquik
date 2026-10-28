import { ConvexError, v } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { argument, events, find, parse, send, validator } from "../src/component/request.js";
import type { Operation } from "../src/component/shape.js";
import { toValue } from "../src/component/values.js";
import { rejection, stubFetch } from "./helpers.js";

const options = { apiKey: "xq_test", streamMs: 50 };

const search: Operation = {
  method: "GET",
  path: "/api/v1/things/{id}",
  params: [
    { name: "id", in: "path", wire: "id" },
    { name: "tags", in: "query", wire: "tags" },
    { name: "limit", in: "query", wire: "limit" },
    { name: "idempotencyKey", in: "header", wire: "Idempotency-Key" },
  ],
  body: null,
  response: "json",
  args: {},
};

const create: Operation = { ...search, method: "POST", params: [], body: ["text", "goal"], path: "/api/v1/things" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("send", () => {
  test("puts path, query and header arguments where the operation says", async () => {
    const recorded = stubFetch(() => Response.json({ id: "1" }));
    const result = await send(search, { id: "a b", tags: ["x", "y"], limit: 5, idempotencyKey: "k1" }, options);
    expect(result).toEqual({ id: "1" });
    const [request] = recorded;
    expect(request?.url.toString()).toBe("https://xquik.com/api/v1/things/a%20b?tags=x&tags=y&limit=5");
    expect([...(request?.headers ?? [])]).toEqual([
      ["idempotency-key", "k1"],
      ["user-agent", "convex-xquik"],
      ["x-api-key", "xq_test"],
    ]);
    expect(request?.body).toBe("");
  });

  test("leaves out query and header arguments without values", async () => {
    const recorded = stubFetch(() => Response.json({}));
    await send(search, { id: "1" }, options);
    expect(recorded[0]?.url.toString()).toBe("https://xquik.com/api/v1/things/1");
    expect([...(recorded[0]?.headers.keys() ?? [])]).toEqual(["user-agent", "x-api-key"]);
  });

  test("sends a non-string argument as JSON", async () => {
    const recorded = stubFetch(() => Response.json({}));
    await send(search, { id: "1", limit: { max: 5 } }, options);
    expect(recorded[0]?.url.searchParams.get("limit")).toBe('{"max":5}');
  });

  test("sends only the body fields that have values", async () => {
    const recorded = stubFetch(() => new Response(""));
    expect(await send(create, { text: "hello", goal: undefined }, options)).toBeNull();
    expect(recorded[0]?.body).toBe('{"text":"hello"}');
    expect(recorded[0]?.headers.get("content-type")).toBe("application/json");
  });

  test("throws a ConvexError with the API error, status and retry delay", async () => {
    stubFetch(() => Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "7" } }));
    expect(await rejection(send(search, { id: "1" }, options))).toEqual({
      error: "rate_limited",
      status: 429,
      retryAfter: 7,
    });
  });

  test("keeps a plain text error as the message", async () => {
    stubFetch(() => new Response("bad gateway", { status: 502 }));
    expect(await rejection(send(search, { id: "1" }, options))).toEqual({ message: "bad gateway", status: 502 });
  });

  test("refuses to call without an API key", async () => {
    const recorded = stubFetch(() => Response.json({}));
    const missing = {
      status: 401,
      error: "missing_api_key",
      message: "Set XQUIK_API_KEY in the Convex dashboard and pass it to the xquik component in convex.config.ts.",
    };
    expect(await rejection(send(search, { id: "1" }, { ...options, apiKey: undefined }))).toEqual(missing);
    expect(await rejection(send(search, { id: "1" }, { ...options, apiKey: "" }))).toEqual(missing);
    expect(recorded).toHaveLength(0);
  });

  test("returns bytes for a binary export", async () => {
    stubFetch(() => new Response(new Uint8Array([1, 2, 3])));
    const result = await send({ ...search, response: "bytes" }, { id: "1" }, options);
    expect(result instanceof ArrayBuffer ? [...new Uint8Array(result)] : result).toEqual([1, 2, 3]);
  });

  test("reads an event stream until it ends", async () => {
    stubFetch(() => new Response('id: 1\nevent: tweet.new\ndata: {"a":1}\n\ndata: plain\n\n'));
    expect(await send({ ...search, response: "events" }, { id: "1" }, options)).toEqual([
      { id: "1", event: "tweet.new", data: { a: 1 } },
      { data: "plain" },
    ]);
  });

  test("stops reading an open event stream after the time limit", async () => {
    const encoder = new TextEncoder();
    const open = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        controller.enqueue(encoder.encode("data: 1\n\n"));
      },
    });
    stubFetch(() => new Response(open));
    expect(await send({ ...search, response: "events" }, { id: "1" }, options)).toEqual([{ data: 1 }]);
  });

  test("decodes a character split across stream chunks", async () => {
    const bytes = new TextEncoder().encode("data: é\n\n");
    const split = bytes.indexOf(0xa9);
    const chunked = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    stubFetch(() => new Response(chunked));
    expect(await send({ ...search, response: "events" }, { id: "1" }, options)).toEqual([{ data: "é" }]);
  });

  test("leaves no timer running once the stream ends", async () => {
    vi.useFakeTimers();
    stubFetch(() => new Response("data: 1\n\n"));
    expect(await send({ ...search, response: "events" }, { id: "1" }, options)).toEqual([{ data: 1 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("returns no events for an empty stream body", async () => {
    stubFetch(() => new Response(null));
    expect(await send({ ...search, response: "events" }, { id: "1" }, options)).toEqual([]);
  });

  test("returns null for an operation without a JSON answer", async () => {
    stubFetch(() => new Response("accepted", { status: 202 }));
    expect(await send({ ...search, response: "none" }, { id: "1" }, options)).toBeNull();
  });
});

describe("parsing", () => {
  test("events keeps id, event and data and skips comments and blocks without data", () => {
    expect(events(": ping\n\nevent: x\n\nretry: 5\ndata: a\ndata: b\nid: 9\n\nnocolon\n\n")).toEqual([
      { id: "9", data: "a\nb" },
    ]);
    expect(events("data\n\nid\ndata:a b\n\n")).toEqual([{ data: "" }, { id: "", data: "a b" }]);
  });

  test("toValue keeps JSON values and turns anything else into null", () => {
    expect(toValue({ a: [1, "b", true, null, undefined], c: () => 1 })).toEqual({
      a: [1, "b", true, null, null],
      c: null,
    });
    expect(parse('{"x":[1,{"y":"z"}]}')).toEqual({ x: [1, { y: "z" }] });
  });

  test("validator builds Convex validators from shapes", () => {
    expect(validator({ union: ["string", { literal: 1 }] })).toEqual(v.union(v.string(), v.literal(1)));
    expect(validator({ record: "boolean" })).toEqual(v.record(v.string(), v.boolean()));
    expect(validator({ array: "null" })).toEqual(v.array(v.null()));
    expect(validator({ object: { a: { shape: "number", optional: true } } })).toEqual(
      v.object({ a: v.optional(v.number()) }),
    );
    expect(validator("any")).toEqual(v.any());
  });

  test("argument returns one argument's validator and names a missing one", () => {
    expect(argument(find("getUser"), "id")).toEqual(v.string());
    expect(() => argument(find("getUser"), "nope")).toThrow("GET /api/v1/x/users/{id} has no argument nope.");
  });

  test("find names an unknown operation", () => {
    expect(() => find("nope")).toThrow(ConvexError);
    expect(find("getUser").path).toBe("/api/v1/x/users/{id}");
  });
});
