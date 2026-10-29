import { componentTest, rejection, SECRET, stubFetch } from "./helpers.js";
import { describe, expect, it, vi } from "vitest";
import { api } from "#src/component/_generated/api.ts";
import { none } from "#src/component/shape.ts";

const NO_REQUESTS = 0;
const PAGE = { paginationOpts: { cursor: none, numItems: 10 } };
const MISSING = {
  error: "missing_api_key",
  message: "Set XQUIK_API_KEY in the Convex dashboard and pass it to the xquik component in convex.config.ts.",
  status: 401,
};

describe("access", () => {
  it("every public component function refuses a deployment without XQUIK_API_KEY", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = componentTest();
    const recorded = stubFetch(() => Response.json({}));
    const jobId = await convex.mutation(api.jobs.enqueue, {
      args: { id: "NASA" },
      delayMs: 60_000,
      operation: "getUser",
    });
    const { endpointId } = await convex.mutation(api.webhooks.add, { secret: SECRET });
    vi.stubEnv("XQUIK_API_KEY", "");
    const calls = {
      "events.get": convex.query(api.events.get, { streamEventId: "9001" }),
      "events.list": convex.query(api.events.list, PAGE),
      "jobs.cancel": convex.mutation(api.jobs.cancel, { jobId }),
      "jobs.enqueue": convex.mutation(api.jobs.enqueue, { args: { id: "NASA" }, operation: "getUser" }),
      "jobs.get": convex.query(api.jobs.get, { jobId }),
      "jobs.list": convex.query(api.jobs.list, PAGE),
      "operations.getUser": convex.action(api.operations.getUser, { id: "NASA" }),
      "webhooks.add": convex.mutation(api.webhooks.add, { secret: SECRET }),
      "webhooks.create": convex.action(api.webhooks.create, { eventTypes: ["tweet.new"] }),
      "webhooks.list": convex.query(api.webhooks.list, PAGE),
      "webhooks.remove": convex.action(api.webhooks.remove, { endpointId }),
    };
    const outcomes = await Promise.all(Object.values(calls).map(async (call) => await rejection(call)));
    expect(Object.fromEntries(Object.keys(calls).map((name, index) => [name, outcomes[index]]))).toStrictEqual({
      "events.get": MISSING,
      "events.list": MISSING,
      "jobs.cancel": MISSING,
      "jobs.enqueue": MISSING,
      "jobs.get": MISSING,
      "jobs.list": MISSING,
      "operations.getUser": MISSING,
      "webhooks.add": MISSING,
      "webhooks.create": MISSING,
      "webhooks.list": MISSING,
      "webhooks.remove": MISSING,
    });
    expect(recorded).toHaveLength(NO_REQUESTS);
  });
});
