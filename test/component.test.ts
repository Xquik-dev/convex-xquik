import { expect, test } from "vitest";
import component from "../src/component/convex.config.js";

test("the component is named xquik and takes an optional XQUIK_API_KEY", () => {
  const analyze: unknown = Reflect.get(component, "export");
  const exported: unknown = typeof analyze === "function" ? Reflect.apply(analyze, component, []) : null;
  expect(exported).toMatchObject({
    name: "xquik",
    envVars: [["XQUIK_API_KEY", { type: "value", value: JSON.stringify({ type: "string" }), optional: true }]],
  });
});
