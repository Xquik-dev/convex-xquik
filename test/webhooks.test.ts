import type { TestConvex } from "convex-test";
import type schema from "../src/component/schema.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../src/component/_generated/api.js";
import crons from "../src/component/crons.js";
import { check, NONCE_TTL_MS, pulledEvents, readDelivery, TOLERANCE_MS } from "../src/component/delivery.js";
import { PURGE_BATCH } from "../src/component/webhooks.js";
import {
  componentTest,
  delivery,
  rejection,
  sign,
  SECRET,
  SITE,
  stubFetch,
  TEST_ALERT,
  type Signed,
} from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function setup(): Promise<{
  t: TestConvex<typeof schema>;
  post: (signed: Signed) => Promise<[number, string]>;
  endpointId: string;
}> {
  const t = componentTest();
  const { endpointId, url } = await t.mutation(api.webhooks.add, { secret: SECRET });
  const path = new URL(url).pathname.replace("/xquik", "");
  const post = async (signed: Signed): Promise<[number, string]> => {
    const response = await t.fetch(path, { method: "POST", ...signed });
    return [response.status, await response.text()];
  };
  return { t, post, endpointId };
}

describe("the webhook receiver", () => {
  test("gives each endpoint its own URL and never lists the secret", async () => {
    const { t, endpointId } = await setup();
    const listed = await t.query(api.webhooks.list, {});
    expect(listed).toHaveLength(1);
    expect(listed[0]?.endpointId).toBe(endpointId);
    expect(listed[0]?.url.startsWith(`${SITE}/webhooks/`)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  test("records the test alert on the endpoint", async () => {
    const { t, post } = await setup();
    expect(await post(sign(TEST_ALERT))).toEqual([200, "test"]);
    const [endpoint] = await t.query(api.webhooks.list, {});
    expect(endpoint?.testedAt).toBeTypeOf("number");
  });

  test("stores a retry once although it carries a new nonce and signature", async () => {
    const { t, post } = await setup();
    expect(await post(sign(delivery("tweet.new", "1")))).toEqual([200, "stored"]);
    expect(await post(sign(delivery("tweet.new", "1")))).toEqual([200, "duplicate"]);
    const page = await t.query(api.events.list, { paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page).toHaveLength(1);
  });

  test("rejects a replayed nonce, also after a purge", async () => {
    const { t, post } = await setup();
    const signed = sign(delivery("tweet.new", "1"));
    expect(await post(signed)).toEqual([200, "stored"]);
    expect(await post(signed)).toEqual([401, "replayed nonce"]);
    expect(await t.mutation(internal.webhooks.purge, {})).toBe(0);
    expect(await post(signed)).toEqual([401, "replayed nonce"]);
  });

  test("rejects a timestamp in seconds or more than 5 minutes off", async () => {
    const { post } = await setup();
    const body = delivery("tweet.new", "1");
    expect(await post(sign(body, { timestamp: String(Math.floor(Date.now() / 1000)) }))).toEqual([
      401,
      "stale timestamp",
    ]);
    expect(await post(sign(body, { timestamp: String(Date.now() - TOLERANCE_MS - 1000) }))).toEqual([
      401,
      "stale timestamp",
    ]);
    expect(await post(sign(body, { timestamp: String(Date.now() + TOLERANCE_MS + 1000) }))).toEqual([
      401,
      "stale timestamp",
    ]);
    expect(await post(sign(body, { timestamp: "17e11" }))).toEqual([401, "stale timestamp"]);
  });

  test("rejects a changed body, a wrong secret and malformed headers", async () => {
    const { post } = await setup();
    const signed = sign(delivery("tweet.new", "1"));
    expect(await post({ ...signed, body: ` ${signed.body}` })).toEqual([401, "bad signature"]);
    expect(await post(sign(signed.body, { secret: "cd".repeat(32) }))).toEqual([401, "bad signature"]);
    expect(await post(sign(signed.body, { nonce: "short" }))).toEqual([401, "bad signature"]);
    const unsigned = Object.fromEntries(
      Object.entries(signed.headers).filter(([name]) => name !== "x-xquik-signature"),
    );
    expect(await post({ ...signed, headers: unsigned })).toEqual([401, "bad signature"]);
    expect(await post({ body: signed.body, headers: {} })).toEqual([401, "stale timestamp"]);
  });

  test("answers 400 to a signed body that is not an Xquik delivery", async () => {
    const { post } = await setup();
    expect(await post(sign("not json"))).toEqual([400, "not an Xquik delivery"]);
    expect(await post(sign(JSON.stringify({ eventType: "tweet.new" })))).toEqual([400, "not an Xquik delivery"]);
    expect(await post(sign(delivery("tweet.new", "1", { occurredAt: "soon" })))).toEqual([
      400,
      "not an Xquik delivery",
    ]);
    expect(await post(sign(delivery("tweet.new", "1", { occurredAt: 2026 })))).toEqual([400, "not an Xquik delivery"]);
    expect(await post(sign(delivery("tweet.new", "1", { streamEventId: 1 })))).toEqual([400, "not an Xquik delivery"]);
    expect(await post(sign(delivery("tweet.new", "1", { eventType: 1 })))).toEqual([400, "not an Xquik delivery"]);
    expect(await post(sign("null"))).toEqual([400, "not an Xquik delivery"]);
  });

  test("answers 404 for an unknown URL and refuses other methods", async () => {
    const { t } = await setup();
    const response = await t.fetch("/webhooks/unknown", { method: "POST", ...sign(TEST_ALERT) });
    expect([response.status, response.headers.get("content-type"), await response.text()]).toEqual([
      404,
      "text/plain",
      "unknown webhook URL",
    ]);
    expect((await t.fetch("/webhooks/unknown", { method: "GET" })).status).toBe(404);
  });

  test("schedules the app's handler once per new event", async () => {
    vi.useFakeTimers();
    const t = componentTest();
    const handle = "function://;webhooks:purge";
    const { url } = await t.mutation(api.webhooks.add, { secret: SECRET, onEvent: handle });
    const path = new URL(url).pathname.replace("/xquik", "");
    await t.fetch(path, { method: "POST", ...sign(delivery("tweet.new", "1")) });
    await t.fetch(path, { method: "POST", ...sign(delivery("tweet.new", "1")) });
    const scheduled = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").take(10));
    expect(scheduled.map((job) => JSON.stringify(job)).join()).toContain('"streamEventId":"1"');
    expect(scheduled).toHaveLength(1);
  });

  test("stores an event whose endpoint was removed during the delivery", async () => {
    const t = componentTest();
    const { endpointId } = await t.mutation(api.webhooks.add, { secret: SECRET });
    await t.run(async (ctx) => {
      await ctx.db.delete("endpoints", endpointId);
    });
    const event = { streamEventId: "1", eventType: "tweet.new", occurredAt: 1, data: null };
    expect(await t.mutation(internal.webhooks.ingest, { endpointId, nonce: "n", event })).toBe("stored");
  });

  test("refuses an onEvent value that is not a function handle", async () => {
    const t = componentTest();
    expect(await rejection(t.mutation(api.webhooks.add, { secret: SECRET, onEvent: "example:onEvent" }))).toEqual({
      status: 400,
      error: "invalid_handle",
      message: "Pass onEvent as a function handle from createFunctionHandle, or use the Xquik client class.",
    });
  });

  test("purges expired nonces in batches until none is left", async () => {
    vi.useFakeTimers();
    const t = componentTest();
    const { endpointId } = await t.mutation(api.webhooks.add, { secret: SECRET });
    await t.run(async (ctx) => {
      for (let index = 0; index <= PURGE_BATCH; index += 1) {
        await ctx.db.insert("nonces", { endpointId, nonce: String(index), expiresAt: Date.now() - 1 });
      }
      await ctx.db.insert("nonces", { endpointId, nonce: "fresh", expiresAt: Date.now() + NONCE_TTL_MS });
    });
    expect(await t.mutation(internal.webhooks.purge, {})).toBe(PURGE_BATCH);
    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();
    const left = await t.run(async (ctx) => await ctx.db.query("nonces").take(10));
    expect(left.map((row) => row.nonce)).toEqual(["fresh"]);
    const runs = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").take(10));
    expect(runs.map((run) => run.state.kind)).toEqual(["success"]);
  });
});

describe("creating and removing webhooks through Xquik", () => {
  test("creates the Xquik webhook at the receiver URL and keeps its secret", async () => {
    const t = componentTest();
    const recorded = stubFetch(() =>
      Response.json({ id: "42", secret: SECRET, url: "x", eventTypes: [], createdAt: "" }),
    );
    const created = await t.action(api.webhooks.create, { eventTypes: ["tweet.new"] });
    expect(created.webhookId).toBe("42");
    expect(JSON.parse(recorded[0]?.body ?? "")).toEqual({ eventTypes: ["tweet.new"], url: created.url });
    const path = new URL(created.url).pathname.replace("/xquik", "");
    expect((await t.fetch(path, { method: "POST", ...sign(TEST_ALERT) })).status).toBe(200);
    const [listed] = await t.query(api.webhooks.list, {});
    expect([listed?.endpointId, listed?.url, listed?.webhookId, typeof listed?.testedAt]).toEqual([
      created.endpointId,
      created.url,
      "42",
      "number",
    ]);
    const removal = stubFetch(() => Response.json({ success: true }));
    await t.action(api.webhooks.remove, { endpointId: created.endpointId });
    expect(removal.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual(["DELETE /api/v1/webhooks/42"]);
    expect(await t.query(api.webhooks.list, {})).toEqual([]);
    expect(await t.query(internal.webhooks.webhookOf, { endpointId: created.endpointId })).toBeNull();
  });

  test("passes a function handle through and rejects an answer without a secret", async () => {
    const t = componentTest();
    stubFetch(() => Response.json({ id: "42", secret: SECRET }));
    const created = await t.action(api.webhooks.create, { eventTypes: ["tweet.new"], onEvent: "function://;x:y" });
    expect(created.webhookId).toBe("42");
    for (const answer of [[], { id: "42" }, { secret: SECRET }]) {
      stubFetch(() => Response.json(answer));
      expect(await rejection(t.action(api.webhooks.create, { eventTypes: ["tweet.new"] }))).toEqual({
        status: 502,
        error: "invalid_response",
        message: "Xquik returned no webhook ID or secret.",
      });
    }
  });

  test("removes an endpoint added by secret without calling Xquik", async () => {
    const t = componentTest();
    const recorded = stubFetch(() => Response.json({}));
    const { endpointId } = await t.mutation(api.webhooks.add, { secret: SECRET });
    await t.action(api.webhooks.remove, { endpointId });
    expect(recorded).toHaveLength(0);
  });
});

describe("delivery parsing", () => {
  test("check accepts only a matching HMAC over the raw bytes", async () => {
    const signed = sign("{}");
    const body = new TextEncoder().encode(signed.body).buffer;
    expect(await check(SECRET, new Headers(signed.headers), body, Date.now())).toEqual({
      ok: true,
      nonce: signed.headers["x-xquik-nonce"],
    });
  });

  test("check accepts a timestamp up to 5 minutes off", async () => {
    const now = Date.parse("2026-10-28T19:00:00.000Z");
    const body = new TextEncoder().encode("{}").buffer;
    const at = async (timestamp: number): Promise<unknown> =>
      await check(SECRET, new Headers(sign("{}", { timestamp: String(timestamp) }).headers), body, now);
    expect(await at(now - 300_000)).toMatchObject({ ok: true });
    expect(await at(now + 300_000)).toMatchObject({ ok: true });
    expect(await at(now - 300_001)).toEqual({ ok: false, reason: "stale timestamp" });
  });

  test("check refuses headers with extra characters around a valid value", async () => {
    const now = Date.now();
    const body = new TextEncoder().encode("{}").buffer;
    const nonce = "ab".repeat(16);
    const verdict = async (signed: Signed): Promise<unknown> =>
      await check(SECRET, new Headers(signed.headers), body, now);
    expect(await verdict(sign("{}", { timestamp: `x${String(now)}` }))).toEqual({
      ok: false,
      reason: "stale timestamp",
    });
    expect(await verdict(sign("{}", { timestamp: `${String(now)}x` }))).toEqual({
      ok: false,
      reason: "stale timestamp",
    });
    expect(await verdict(sign("{}", { nonce: `x${nonce}` }))).toEqual({ ok: false, reason: "bad signature" });
    expect(await verdict(sign("{}", { nonce: `${nonce}x` }))).toEqual({ ok: false, reason: "bad signature" });
    const signed = sign("{}");
    const signature = signed.headers["x-xquik-signature"] ?? "";
    for (const changed of [`x${signature}`, `${signature}0`]) {
      const headers = { ...signed.headers, "x-xquik-signature": changed };
      expect(await verdict({ ...signed, headers })).toEqual({ ok: false, reason: "bad signature" });
    }
  });

  test("check keeps the signing secret in a key that cannot be exported", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const signed = sign("{}");
    await check(SECRET, new Headers(signed.headers), new TextEncoder().encode(signed.body).buffer, Date.now());
    expect(importKey.mock.calls.map((call) => [call[3], call[4]])).toEqual([[false, ["verify"]]]);
    importKey.mockRestore();
  });

  test("readDelivery keeps the event fields the component stores", () => {
    expect(readDelivery(delivery("tweet.new", "5", { monitorId: 10 }))).toEqual({
      kind: "event",
      event: {
        streamEventId: "5",
        eventType: "tweet.new",
        occurredAt: Date.parse("2026-10-28T19:00:00.000Z"),
        data: { id: "1893456789012345678", text: "The future is now." },
      },
    });
    expect(readDelivery("[]")).toBeNull();
  });

  test("pulledEvents reads the events list of a listEvents answer", () => {
    expect(pulledEvents(null)).toEqual([]);
    expect(pulledEvents({ events: 5 })).toEqual([]);
  });

  test("the cron purges expired nonces every 10 minutes", () => {
    expect(crons.crons["purge expired webhook nonces"]?.schedule).toEqual({ type: "interval", minutes: 10 });
  });
});
