import { assert, describe, expect, it } from "vitest";
import component from "#src/component/convex.config.ts";

describe("the component definition", () => {
  it("is named xquik and takes an optional XQUIK_API_KEY", { timeout: 5000 }, () => {
    expect.hasAssertions();
    const analyze: unknown = Reflect.get(component, "export");
    assert(typeof analyze === "function");
    const exported: unknown = Reflect.apply(analyze, component, []);
    expect(exported).toMatchObject({
      envVars: [["XQUIK_API_KEY", { optional: true, type: "value", value: JSON.stringify({ type: "string" }) }]],
      name: "xquik",
    });
  });
});
