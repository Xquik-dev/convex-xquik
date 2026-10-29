import type { GenericSchema, SchemaDefinition } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
import schema from "./component/schema.js";
import type { TestConvex } from "convex-test";

const modules: Record<string, () => Promise<unknown>> = {
  "./component/_generated/api.ts": async () => await import("./component/_generated/api.js"),
  "./component/crons.ts": async () => await import("./component/crons.js"),
  "./component/events.ts": async () => await import("./component/events.js"),
  "./component/http.ts": async () => await import("./component/http.js"),
  "./component/jobs.ts": async () => await import("./component/jobs.js"),
  "./component/operations.ts": async () => await import("./component/operations.js"),
  "./component/webhooks.ts": async () => await import("./component/webhooks.js"),
};

function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  testConvex: Readonly<TestConvex<Schema>>,
  name = "xquik",
): ComponentApi {
  return testConvex.registerComponent<ComponentApi>(name, schema, modules);
}

const xquikTest = { modules, register, schema };

export { register };
export default xquikTest;
