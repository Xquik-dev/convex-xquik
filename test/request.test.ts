import { describe, expect, it, vi } from "vitest";
import type { Operation, Shape } from "#src/component/shape.ts";
import { rejection, stubFetch } from "./helpers.js";
import type { Options } from "#src/component/request.ts";
import { send } from "#src/component/request.ts";

const STREAM_MS = 50;
const ACCENT_SECOND_BYTE = 169;

const options = { apiKey: "xq_test", streamMs: STREAM_MS };

const PARAMS: Operation["params"] = [
  { in: "path", name: "id", wire: "id" },
  { in: "query", name: "tags", wire: "tags" },
  { in: "query", name: "limit", wire: "limit" },
  { in: "header", name: "idempotencyKey", wire: "Idempotency-Key" },
];

function thing(response: Operation["response"], result: Shape = "any"): Operation {
  return { args: {}, body: null, method: "GET", params: PARAMS, path: "/api/v1/things/{id}", response, result };
}

const search = thing("json");

const create: Operation = {
  args: {},
  body: ["text", "goal"],
  method: "POST",
  params: [],
  path: "/api/v1/things",
  response: "json",
  result: "any",
};

async function withFakeTimers(
  run: () => Promise<unknown>,
): Promise<{ readonly result: unknown; readonly timers: number }> {
  vi.useFakeTimers();
  try {
    const result = await run();
    return { result, timers: vi.getTimerCount() };
  } finally {
    vi.useRealTimers();
  }
}

describe("send builds the request", () => {
  it("puts path, query and header arguments where the operation says", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const recorded = stubFetch(() => Response.json({ id: "1" }));
    await expect(
      send(search, { id: "a b", idempotencyKey: "k1", limit: 5, tags: ["x", "y"] }, options),
    ).resolves.toStrictEqual({ id: "1" });
    expect(recorded.map(({ body, headers, url }) => ({ body, headers: [...headers], url: url.href }))).toStrictEqual([
      {
        body: "",
        headers: [
          ["idempotency-key", "k1"],
          ["user-agent", "xquik-convex"],
          ["x-api-key", "xq_test"],
        ],
        url: "https://xquik.com/api/v1/things/a%20b?tags=x&tags=y&limit=5",
      },
    ]);
  });

  it("leaves out query and header arguments without values", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const recorded = stubFetch(() => Response.json({}));
    await send(search, { id: "1" }, options);
    expect(recorded.map(({ headers, url }) => ({ headers: [...headers.keys()], url: url.href }))).toStrictEqual([
      { headers: ["user-agent", "x-api-key"], url: "https://xquik.com/api/v1/things/1" },
    ]);
  });

  it("sends a non-string argument as JSON", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const recorded = stubFetch(() => Response.json({}));
    await send(search, { id: "1", limit: { max: 5 } }, options);
    expect(recorded.map(({ url }) => url.searchParams.get("limit"))).toStrictEqual(['{"max":5}']);
  });

  it("sends only the body fields that have values", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const recorded = stubFetch(() => new Response(""));
    await expect(send(create, { text: "hello" }, options)).resolves.toBeNull();
    expect(recorded.map(({ body, headers }) => ({ body, type: headers.get("content-type") }))).toStrictEqual([
      { body: '{"text":"hello"}', type: "application/json" },
    ]);
  });
});

describe("send reports failures", () => {
  it("throws a ConvexError with the API error, status and retry delay", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    stubFetch(() => Response.json({ error: "rate_limited" }, { headers: { "retry-after": "7" }, status: 429 }));
    await expect(rejection(send(search, { id: "1" }, options))).resolves.toStrictEqual({
      error: "rate_limited",
      retryAfter: 7,
      status: 429,
    });
  });

  it("keeps a plain text error as the message", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    stubFetch(() => new Response("bad gateway", { status: 502 }));
    await expect(rejection(send(search, { id: "1" }, options))).resolves.toStrictEqual({
      message: "bad gateway",
      status: 502,
    });
  });

  it("refuses to call without an API key", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const recorded = stubFetch(() => Response.json({}));
    const missing = {
      error: "missing_api_key",
      message: "Set XQUIK_API_KEY in the Convex dashboard and pass it to the xquik component in convex.config.ts.",
      status: 401,
    };
    const unset: Partial<Options> = {};
    const withoutKey = { apiKey: unset.apiKey, streamMs: STREAM_MS };
    await expect(rejection(send(search, { id: "1" }, withoutKey))).resolves.toStrictEqual(missing);
    const emptyKey = { apiKey: "", streamMs: STREAM_MS };
    await expect(rejection(send(search, { id: "1" }, emptyKey))).resolves.toStrictEqual(missing);
    expect(recorded).toStrictEqual([]);
  });
});

describe("send reads the answer", () => {
  it("keeps only the documented fields of a JSON answer", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    stubFetch(() => Response.json({ extra: true, id: "1", name: "Mars" }));
    await expect(send(thing("json", { ref: "JobLocation" }), { id: "1" }, options)).resolves.toStrictEqual({
      id: "1",
      name: "Mars",
    });
  });

  it("returns bytes for a binary export", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    stubFetch(() => new Response("abc"));
    const expected = await new Response("abc").arrayBuffer();
    await expect(send(thing("bytes"), { id: "1" }, options)).resolves.toStrictEqual(expected);
  });

  it("returns no events for an empty stream body", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    stubFetch(() => new Response(null));
    await expect(send(thing("events"), { id: "1" }, options)).resolves.toStrictEqual([]);
  });

  it("returns null for an operation without a JSON answer", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    stubFetch(() => new Response("accepted", { status: 202 }));
    await expect(send(thing("none"), { id: "1" }, options)).resolves.toBeNull();
  });
});

describe("send reads event streams", () => {
  it("reads an event stream until it ends", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    stubFetch(() => new Response('id: 1\nevent: tweet.new\ndata: {"count":1}\n\ndata: plain\n\n'));
    await expect(send(thing("events"), { id: "1" }, options)).resolves.toStrictEqual([
      { data: { count: 1 }, event: "tweet.new", id: "1" },
      { data: "plain" },
    ]);
  });

  it("stops reading an open event stream after the time limit", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const open = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
      },
    });
    stubFetch(() => new Response(open));
    await expect(send(thing("events"), { id: "1" }, options)).resolves.toStrictEqual([{ data: 1 }]);
  });

  it("decodes a character split across stream chunks", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const bytes = new TextEncoder().encode("data: é\n\n");
    const split = bytes.indexOf(ACCENT_SECOND_BYTE);
    const chunked = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        controller.enqueue(bytes.filter((_byte, index) => index < split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      },
    });
    stubFetch(() => new Response(chunked));
    await expect(send(thing("events"), { id: "1" }, options)).resolves.toStrictEqual([{ data: "é" }]);
  });

  it("leaves no timer running once the stream ends", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    stubFetch(() => new Response("data: 1\n\n"));
    await expect(withFakeTimers(async () => await send(thing("events"), { id: "1" }, options))).resolves.toStrictEqual({
      result: [{ data: 1 }],
      timers: 0,
    });
  });
});
