import { describe, expect, it } from "vitest";
import { api } from "#src/component/_generated/api.ts";
import { componentTest } from "./helpers.js";
import { none } from "#src/component/shape.ts";

const PAGE_SIZE = 2;
const PAGE = { cursor: none, numItems: 10 };
const ROWS = [
  { data: none, eventType: "tweet.new", monitorId: "a", occurredAt: 4, streamEventId: "1" },
  { data: none, eventType: "tweet.reply", monitorId: "a", occurredAt: 1, streamEventId: "2" },
  { data: none, eventType: "tweet.new", monitorId: "b", occurredAt: 2, streamEventId: "3" },
  { data: none, eventType: "tweet.reply", monitorId: "b", occurredAt: 3, streamEventId: "4" },
];

async function seeded(): Promise<ReturnType<typeof componentTest>> {
  const convex = componentTest();
  await convex.run(async (ctx) => {
    await Promise.all(ROWS.map(async (row) => await ctx.db.insert("events", row)));
  });
  return convex;
}

describe("event queries", () => {
  it("list newest first, filtered by type or monitor", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = await seeded();
    const all = await convex.query(api.events.list, { paginationOpts: PAGE });
    const typed = await convex.query(api.events.list, { filter: { eventType: "tweet.new" }, paginationOpts: PAGE });
    const monitored = await convex.query(api.events.list, { filter: { monitorId: "a" }, paginationOpts: PAGE });
    expect(all.page.map((event) => event.streamEventId)).toStrictEqual(["1", "4", "3", "2"]);
    expect(typed.page.map((event) => event.streamEventId)).toStrictEqual(["1", "3"]);
    expect(monitored.page.map((event) => event.streamEventId)).toStrictEqual(["1", "2"]);
  });

  it("page through events and find one by its stream id", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const convex = await seeded();
    const first = await convex.query(api.events.list, { paginationOpts: { cursor: none, numItems: PAGE_SIZE } });
    expect([first.page.length, first.isDone]).toStrictEqual([PAGE_SIZE, false]);
    await expect(convex.query(api.events.get, { streamEventId: "3" })).resolves.toMatchObject({
      eventType: "tweet.new",
    });
    await expect(convex.query(api.events.get, { streamEventId: "5" })).resolves.toBeNull();
  });
});
