import { describe, expect, test } from "vitest";
import { api } from "../src/component/_generated/api.js";
import { componentTest } from "./helpers.js";

describe("event queries", () => {
  test("list newest first, filtered by type or monitor, one page at a time", async () => {
    const t = componentTest();
    await t.run(async (ctx) => {
      const rows = [
        ["1", "tweet.new", "a", 4],
        ["2", "tweet.reply", "a", 1],
        ["3", "tweet.new", "b", 2],
        ["4", "tweet.reply", "b", 3],
      ] as const;
      for (const [id, type, monitor, at] of rows) {
        await ctx.db.insert("events", {
          streamEventId: id,
          eventType: type,
          monitorId: monitor,
          occurredAt: at,
          data: null,
        });
      }
    });
    const ids = async (filter?: { eventType: string } | { monitorId: string }): Promise<string[]> => {
      const page = await t.query(api.events.list, {
        paginationOpts: { numItems: 10, cursor: null },
        ...(filter === undefined ? {} : { filter }),
      });
      return page.page.map((event) => event.streamEventId);
    };
    expect(await ids()).toEqual(["1", "4", "3", "2"]);
    expect(await ids({ eventType: "tweet.new" })).toEqual(["1", "3"]);
    expect(await ids({ monitorId: "a" })).toEqual(["1", "2"]);
    const first = await t.query(api.events.list, { paginationOpts: { numItems: 2, cursor: null } });
    expect([first.page.length, first.isDone]).toEqual([2, false]);
    expect(await t.query(api.events.get, { streamEventId: "3" })).toMatchObject({ eventType: "tweet.new" });
    expect(await t.query(api.events.get, { streamEventId: "5" })).toBeNull();
  });
});
