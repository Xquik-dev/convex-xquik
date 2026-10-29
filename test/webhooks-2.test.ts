import { api, internal } from "#src/component/_generated/api.ts";
import { check, pulledEvents, readDelivery } from "#src/component/delivery.ts";
import { componentTest, delivery, rejection, SECRET, sign, stubFetch, TEST_ALERT } from "./helpers.js";
import { describe, expect, it, vi } from "vitest";
import crons from "#src/component/crons.ts";

const OK = 200;
const MOMENT_MS = 1;
const FIVE_MINUTES_MS = 300_000;
const NONCE_BYTES = 16;
const PAGE = { paginationOpts: { cursor: null, numItems: 10 } };
const STALE = { ok: false, reason: "stale timestamp" };
const BAD = { ok: false, reason: "bad signature" };
const INVALID = {
  error: "invalid_response",
  message: "Xquik returned no webhook ID or secret.",
  status: 502,
};

function pathOf(url: string): string {
  return new URL(url).pathname.replace("/xquik", "");
}

function encoded(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe("creating webhooks through Xquik", () => {
  it("creates the Xquik webhook at the receiver URL and keeps its secret", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = componentTest();
    const recorded = stubFetch(() =>
      Response.json({ createdAt: "", eventTypes: [], id: "42", secret: SECRET, url: "x" }),
    );
    const created = await backend.action(api.webhooks.create, { eventTypes: ["tweet.new"] });
    expect(created.webhookId).toBe("42");
    expect(recorded.map((request): unknown => JSON.parse(request.body))).toStrictEqual([
      { eventTypes: ["tweet.new"], url: created.url },
    ]);
    const { status } = await backend.fetch(
      pathOf(created.url),
      Object.assign(await sign(TEST_ALERT), { method: "POST" }),
    );
    expect(status).toBe(OK);
    const { page } = await backend.query(api.webhooks.list, PAGE);
    expect(
      page.map(({ endpointId, testedAt, url, webhookId }) => [endpointId, url, webhookId, typeof testedAt]),
    ).toStrictEqual([[created.endpointId, created.url, "42", "number"]]);
  });

  it("passes a function handle through and rejects an answer without a secret", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = componentTest();
    stubFetch(() => Response.json({ id: "42", secret: SECRET }));
    const created = await backend.action(api.webhooks.create, {
      eventTypes: ["tweet.new"],
      onEvent: "function://;x:y",
    });
    expect(created.webhookId).toBe("42");
    const refused = async (answer: unknown): Promise<unknown> => {
      stubFetch(() => Response.json(answer));
      return await rejection(backend.action(api.webhooks.create, { eventTypes: ["tweet.new"] }));
    };
    await expect(refused([])).resolves.toStrictEqual(INVALID);
    await expect(refused({ id: "42" })).resolves.toStrictEqual(INVALID);
    await expect(refused({ secret: SECRET })).resolves.toStrictEqual(INVALID);
  });
});

describe("removing webhooks through Xquik", () => {
  it("deletes the Xquik webhook together with its endpoint", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = componentTest();
    stubFetch(() => Response.json({ id: "42", secret: SECRET }));
    const created = await backend.action(api.webhooks.create, { eventTypes: ["tweet.new"] });
    const removal = stubFetch(() => Response.json({ success: true }));
    await backend.action(api.webhooks.remove, { endpointId: created.endpointId });
    expect(removal.map(({ method, url }) => `${method} ${url.pathname}`)).toStrictEqual(["DELETE /api/v1/webhooks/42"]);
    const { page } = await backend.query(api.webhooks.list, PAGE);
    expect(page).toStrictEqual([]);
    await expect(backend.query(internal.webhooks.webhookOf, { endpointId: created.endpointId })).resolves.toBeNull();
  });

  it("removes an endpoint added by secret without calling Xquik", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const backend = componentTest();
    const recorded = stubFetch(() => Response.json({}));
    const { endpointId } = await backend.mutation(api.webhooks.add, { secret: SECRET });
    await backend.action(api.webhooks.remove, { endpointId });
    expect(recorded).toStrictEqual([]);
  });
});

describe("signature checks", () => {
  it("check accepts only a matching HMAC over the raw bytes", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const signed = await sign("{}");
    await expect(check(SECRET, new Headers(signed.headers), encoded(signed.body), Date.now())).resolves.toStrictEqual({
      nonce: signed.headers["x-xquik-nonce"],
      ok: true,
    });
  });

  it("check accepts a timestamp up to 5 minutes off", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const now = Date.parse("2026-10-28T19:00:00.000Z");
    const at = async (timestamp: number): Promise<unknown> => {
      const { headers } = await sign("{}", { timestamp: String(timestamp) });
      return await check(SECRET, new Headers(headers), encoded("{}"), now);
    };
    await expect(at(now - FIVE_MINUTES_MS)).resolves.toMatchObject({ ok: true });
    await expect(at(now + FIVE_MINUTES_MS)).resolves.toMatchObject({ ok: true });
    await expect(at(now - FIVE_MINUTES_MS - MOMENT_MS)).resolves.toStrictEqual(STALE);
  });

  it("check refuses a timestamp or nonce with extra characters", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const now = Date.now();
    const nonce = "ab".repeat(NONCE_BYTES);
    const verdict = async (options: { readonly nonce?: string; readonly timestamp?: string }): Promise<unknown> => {
      const { headers } = await sign("{}", options);
      return await check(SECRET, new Headers(headers), encoded("{}"), now);
    };
    await expect(verdict({ timestamp: `x${String(now)}` })).resolves.toStrictEqual(STALE);
    await expect(verdict({ timestamp: `${String(now)}x` })).resolves.toStrictEqual(STALE);
    await expect(verdict({ nonce: `x${nonce}` })).resolves.toStrictEqual(BAD);
    await expect(verdict({ nonce: `${nonce}x` })).resolves.toStrictEqual(BAD);
  });
});

describe("signature header checks", () => {
  it("check refuses a signature with extra characters", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const signed = await sign("{}");
    const signature = String(signed.headers["x-xquik-signature"]);
    const verdict = async (changed: string): Promise<unknown> => {
      const headers = Object.fromEntries([...Object.entries(signed.headers), ["x-xquik-signature", changed]]);
      return await check(SECRET, new Headers(headers), encoded(signed.body), Date.now());
    };
    await expect(verdict(`x${signature}`)).resolves.toStrictEqual(BAD);
    await expect(verdict(`${signature}0`)).resolves.toStrictEqual(BAD);
  });

  it("check keeps the signing secret in a key that cannot be exported", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const signed = await sign("{}");
    using importKey = vi.spyOn(crypto.subtle, "importKey");
    await check(SECRET, new Headers(signed.headers), encoded(signed.body), Date.now());
    expect(importKey).toHaveBeenCalledExactlyOnceWith("raw", expect.anything(), expect.anything(), false, ["verify"]);
  });
});

describe("delivery parsing", () => {
  it("readDelivery keeps the event fields the component stores", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(readDelivery(delivery("tweet.new", "5", { monitorId: 10 }))).toStrictEqual({
      event: {
        data: { id: "1893456789012345678", text: "The future is now." },
        eventType: "tweet.new",
        occurredAt: Date.parse("2026-10-28T19:00:00.000Z"),
        streamEventId: "5",
      },
      kind: "event",
    });
    expect(readDelivery("[]")).toStrictEqual({ kind: "invalid" });
  });

  it("pulledEvents reads the events list of a listEvents answer", { timeout: 5000 }, () => {
    expect.hasAssertions();
    expect(pulledEvents(null)).toStrictEqual([]);
    expect(pulledEvents({ events: 5 })).toStrictEqual([]);
  });

  it("the cron purges expired nonces every 10 minutes", { timeout: 5000 }, () => {
    expect.hasAssertions();
    const schedule = { minutes: 10, type: "interval" };
    expect(crons.crons).toHaveProperty(["purge expired webhook nonces", "schedule"], schedule);
  });
});
