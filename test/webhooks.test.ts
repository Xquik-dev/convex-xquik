import { api, internal } from "#src/component/_generated/api.ts";
import { componentTest, delivery, rejection, SECRET, sign, SITE, TEST_ALERT } from "./helpers.js";
import { describe, expect, it, vi } from "vitest";

const OK = 200;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const NONE = 0;
const SECOND_MS = 1000;
const MOMENT_MS = 1;
const FIVE_MINUTES_MS = 300_000;
const TEN_MINUTES_MS = 600_000;
const SECRET_BYTES = 32;
const SCAN = 10;
const BATCH = 256;
const EXPIRED_NONCES = 257;
const OTHER_SECRET = "cd".repeat(SECRET_BYTES);
const PAGE = { paginationOpts: { cursor: null, numItems: 10 } };

type Backend = ReturnType<typeof componentTest>;

interface Delivered {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

type Post = (signed: Delivered) => Promise<[number, string]>;

function pathOf(url: string): string {
  return new URL(url).pathname.replace("/xquik", "");
}

function posted(signed: Delivered): RequestInit {
  return { body: signed.body, headers: signed.headers, method: "POST" };
}

async function withFakeTimers<Result>(work: () => Promise<Result>): Promise<Result> {
  vi.useFakeTimers();
  try {
    return await work();
  } finally {
    vi.useRealTimers();
  }
}

async function setup(): Promise<{ backend: Backend; endpointId: string; post: Post; url: string }> {
  const backend = componentTest();
  const { endpointId, url } = await backend.mutation(api.webhooks.add, { secret: SECRET });
  const path = pathOf(url);
  const post = async (signed: Delivered): Promise<[number, string]> => {
    const response = await backend.fetch(path, posted(signed));
    return [response.status, await response.text()];
  };
  return { backend, endpointId, post, url };
}

describe("the webhook receiver endpoints", () => {
  it("gives each endpoint its own URL and never lists the secret", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const { backend, endpointId, url } = await setup();
    const { page: listed } = await backend.query(api.webhooks.list, PAGE);
    expect(listed).toStrictEqual([{ endpointId, testedAt: null, url, webhookId: null }]);
    expect(url.startsWith(`${SITE}/webhooks/`)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  it("pages through endpoints from the newest", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const { backend, endpointId: oldest } = await setup();
    const { endpointId: middle } = await backend.mutation(api.webhooks.add, { secret: SECRET });
    const { endpointId: newest } = await backend.mutation(api.webhooks.add, { secret: SECRET });
    const first = await backend.query(api.webhooks.list, { paginationOpts: { cursor: null, numItems: 2 } });
    const rest = await backend.query(api.webhooks.list, {
      paginationOpts: { cursor: first.continueCursor, numItems: 2 },
    });
    expect([first.page.map((endpoint) => endpoint.endpointId), first.isDone]).toStrictEqual([[newest, middle], false]);
    expect([rest.page.map((endpoint) => endpoint.endpointId), rest.isDone]).toStrictEqual([[oldest], true]);
  });

  it("records the test alert on the endpoint", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const { backend, post } = await setup();
    await expect(post(sign(TEST_ALERT))).resolves.toStrictEqual([OK, "test"]);
    const { page } = await backend.query(api.webhooks.list, PAGE);
    expect(page.map((endpoint) => typeof endpoint.testedAt)).toStrictEqual(["number"]);
  });
});

describe("the webhook receiver deliveries", () => {
  it("stores a retry once although it carries a new nonce and signature", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const { backend, post } = await setup();
    const body = delivery("tweet.new", "1");
    await expect(post(sign(body))).resolves.toStrictEqual([OK, "stored"]);
    await expect(post(sign(body))).resolves.toStrictEqual([OK, "duplicate"]);
    const { page } = await backend.query(api.events.list, PAGE);
    expect(page.map((event) => event.streamEventId)).toStrictEqual(["1"]);
  });

  it("rejects a replayed nonce, also after a purge", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const { backend, post } = await setup();
    const signed = sign(delivery("tweet.new", "1"));
    await expect(post(signed)).resolves.toStrictEqual([OK, "stored"]);
    await expect(post(signed)).resolves.toStrictEqual([UNAUTHORIZED, "replayed nonce"]);
    await expect(backend.mutation(internal.webhooks.purge, {})).resolves.toBe(NONE);
    await expect(post(signed)).resolves.toStrictEqual([UNAUTHORIZED, "replayed nonce"]);
  });

  it("rejects a timestamp in seconds or more than 5 minutes off", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const { post } = await setup();
    const now = Date.now();
    const body = delivery("tweet.new", "1");
    const late = now - FIVE_MINUTES_MS - SECOND_MS;
    const early = now + FIVE_MINUTES_MS + SECOND_MS;
    const timestamps = [String(Math.floor(now / SECOND_MS)), String(late), String(early), "17e11"];
    const signed = timestamps.map((timestamp) => sign(body, { timestamp }));
    const answers = await Promise.all(signed.map(async (request) => await post(request)));
    expect(answers).toStrictEqual(timestamps.map(() => [UNAUTHORIZED, "stale timestamp"]));
  });
});

describe("the webhook receiver signatures", () => {
  it("rejects a changed body, a wrong secret and malformed headers", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const { post } = await setup();
    const signed = sign(delivery("tweet.new", "1"));
    const bad = [UNAUTHORIZED, "bad signature"];
    const unsigned = Object.fromEntries(
      Object.entries(signed.headers).filter(([name]) => name !== "x-xquik-signature"),
    );
    await expect(post({ body: ` ${signed.body}`, headers: signed.headers })).resolves.toStrictEqual(bad);
    await expect(post(sign(signed.body, { secret: OTHER_SECRET }))).resolves.toStrictEqual(bad);
    await expect(post(sign(signed.body, { nonce: "short" }))).resolves.toStrictEqual(bad);
    await expect(post({ body: signed.body, headers: unsigned })).resolves.toStrictEqual(bad);
    await expect(post({ body: signed.body, headers: {} })).resolves.toStrictEqual([UNAUTHORIZED, "stale timestamp"]);
  });

  it("answers 400 to a signed body that is not an Xquik delivery", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const { post } = await setup();
    const bodies = [
      "not json",
      JSON.stringify({ eventType: "tweet.new" }),
      delivery("tweet.new", "1", { occurredAt: "soon" }),
      delivery("tweet.new", "1", { occurredAt: 2026 }),
      delivery("tweet.new", "1", { streamEventId: 1 }),
      delivery("tweet.new", "1", { eventType: 1 }),
      "null",
    ];
    const signed = bodies.map((body) => sign(body));
    const answers = await Promise.all(signed.map(async (request) => await post(request)));
    expect(answers).toStrictEqual(bodies.map(() => [BAD_REQUEST, "not an Xquik delivery"]));
  });

  it("answers 404 for an unknown URL and refuses other methods", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const { backend } = await setup();
    const response = await backend.fetch("/webhooks/unknown", posted(sign(TEST_ALERT)));
    const answer = [response.status, response.headers.get("content-type"), await response.text()];
    expect(answer).toStrictEqual([NOT_FOUND, "text/plain", "unknown webhook URL"]);
    const { status } = await backend.fetch("/webhooks/unknown", { method: "GET" });
    expect(status).toBe(NOT_FOUND);
  });
});

describe("the webhook receiver handlers", () => {
  it("schedules the app's handler once per new event", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const scheduled = await withFakeTimers(async () => {
      const backend = componentTest();
      const { url } = await backend.mutation(api.webhooks.add, {
        onEvent: "function://;webhooks:purge",
        secret: SECRET,
      });
      const body = delivery("tweet.new", "1");
      await backend.fetch(pathOf(url), posted(sign(body)));
      await backend.fetch(pathOf(url), posted(sign(body)));
      return await backend.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").take(SCAN));
    });
    expect(scheduled.map((job) => JSON.stringify(job)).join(",")).toContain('"streamEventId":"1"');
    expect(scheduled.map((job) => job.name)).toStrictEqual(["webhooks:purge"]);
  });

  it("runs each endpoint's handler once, even for an event a pull stored first", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const outcome = await withFakeTimers(async () => {
      const backend = componentTest();
      await backend.run(async (ctx) => {
        await ctx.db.insert("events", { data: null, eventType: "tweet.new", occurredAt: 1, streamEventId: "1" });
      });
      const { url: purger } = await backend.mutation(api.webhooks.add, {
        onEvent: "function://;webhooks:purge",
        secret: SECRET,
      });
      const { url: lister } = await backend.mutation(api.webhooks.add, {
        onEvent: "function://;webhooks:list",
        secret: SECRET,
      });
      const body = delivery("tweet.new", "1");
      const deliver = async (url: string): Promise<string> => {
        const response = await backend.fetch(pathOf(url), posted(sign(body)));
        return await response.text();
      };
      const answers = [await deliver(purger), await deliver(lister), await deliver(purger), await deliver(lister)];
      const scheduled = await backend.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").take(SCAN));
      const { page } = await backend.query(api.events.list, PAGE);
      return { answers, events: page, scheduled };
    });
    expect(outcome.answers).toStrictEqual(["stored", "stored", "duplicate", "duplicate"]);
    expect(outcome.scheduled.map((job) => job.name).toSorted()).toStrictEqual(["webhooks:list", "webhooks:purge"]);
    expect(outcome.events.map((event) => event.streamEventId)).toStrictEqual(["1"]);
  });
});

describe("the webhook receiver edge cases", () => {
  it("stores an event whose endpoint was removed during the delivery", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = componentTest();
    const { endpointId } = await backend.mutation(api.webhooks.add, { secret: SECRET });
    await backend.run(async (ctx) => {
      await ctx.db.delete("endpoints", endpointId);
    });
    const event = { data: null, eventType: "tweet.new", occurredAt: 1, streamEventId: "1" };
    await expect(backend.mutation(internal.webhooks.ingest, { endpointId, event, nonce: "n" })).resolves.toBe("stored");
  });

  it("refuses an onEvent value that is not a function handle", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = componentTest();
    await expect(
      rejection(backend.mutation(api.webhooks.add, { onEvent: "example:onEvent", secret: SECRET })),
    ).resolves.toStrictEqual({
      error: "invalid_handle",
      message: "Pass onEvent as a function handle from createFunctionHandle, or use the Xquik client class.",
      status: 400,
    });
  });

  it("purges expired nonces in batches until none is left", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const outcome = await withFakeTimers(async () => {
      const backend = componentTest();
      const { endpointId } = await backend.mutation(api.webhooks.add, { secret: SECRET });
      await backend.run(async (ctx) => {
        const expiresAt = Date.now() - MOMENT_MS;
        const nonces = Array.from({ length: EXPIRED_NONCES }, (_item, index) => String(index));
        await Promise.all(nonces.map(async (nonce) => await ctx.db.insert("nonces", { endpointId, expiresAt, nonce })));
        await ctx.db.insert("nonces", { endpointId, expiresAt: Date.now() + TEN_MINUTES_MS, nonce: "fresh" });
      });
      const purged = await backend.mutation(internal.webhooks.purge, {});
      vi.runAllTimers();
      await backend.finishInProgressScheduledFunctions();
      const left = await backend.run(async (ctx) => await ctx.db.query("nonces").take(SCAN));
      const runs = await backend.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").take(SCAN));
      return { left, purged, runs };
    });
    expect(outcome.purged).toBe(BATCH);
    expect(outcome.left.map((row) => row.nonce)).toStrictEqual(["fresh"]);
    expect(outcome.runs.map((run) => run.state.kind)).toStrictEqual(["success"]);
  });
});
