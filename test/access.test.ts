import { afterEach, expect, test, vi } from "vitest";
import { api } from "../src/component/_generated/api.js";
import { componentTest, rejection, SECRET, stubFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const MISSING = {
  status: 401,
  error: "missing_api_key",
  message: "Set XQUIK_API_KEY in the Convex dashboard and pass it to the xquik component in convex.config.ts.",
};

test("every public component function refuses a deployment without XQUIK_API_KEY", async () => {
  const t = componentTest();
  const recorded = stubFetch(() => Response.json({}));
  const jobId = await t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "NASA" }, delayMs: 60_000 });
  const { endpointId } = await t.mutation(api.webhooks.add, { secret: SECRET });
  vi.stubEnv("XQUIK_API_KEY", "");
  const page = { paginationOpts: { numItems: 10, cursor: null } };
  const calls = {
    "events.list": t.query(api.events.list, page),
    "events.get": t.query(api.events.get, { streamEventId: "9001" }),
    "jobs.enqueue": t.mutation(api.jobs.enqueue, { operation: "getUser", args: { id: "NASA" } }),
    "jobs.cancel": t.mutation(api.jobs.cancel, { jobId }),
    "jobs.get": t.query(api.jobs.get, { jobId }),
    "jobs.list": t.query(api.jobs.list, page),
    "webhooks.create": t.action(api.webhooks.create, { eventTypes: ["tweet.new"] }),
    "webhooks.add": t.mutation(api.webhooks.add, { secret: SECRET }),
    "webhooks.list": t.query(api.webhooks.list, {}),
    "webhooks.remove": t.action(api.webhooks.remove, { endpointId }),
    "operations.getUser": t.action(api.operations.getUser, { id: "NASA" }),
  };
  const outcomes = await Promise.all(Object.values(calls).map(rejection));
  expect(Object.fromEntries(Object.keys(calls).map((name, index) => [name, outcomes[index]]))).toEqual({
    "events.list": MISSING,
    "events.get": MISSING,
    "jobs.enqueue": MISSING,
    "jobs.cancel": MISSING,
    "jobs.get": MISSING,
    "jobs.list": MISSING,
    "webhooks.create": MISSING,
    "webhooks.add": MISSING,
    "webhooks.list": MISSING,
    "webhooks.remove": MISSING,
    "operations.getUser": MISSING,
  });
  expect(recorded).toHaveLength(0);
});
