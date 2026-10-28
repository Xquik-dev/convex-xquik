import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
import schema from "./component/schema.js";

const modules: Record<string, () => Promise<unknown>> = {
  "./component/_generated/api.ts": async () => await import("./component/_generated/api.js"),
  "./component/crons.ts": async () => await import("./component/crons.js"),
  "./component/events.ts": async () => await import("./component/events.js"),
  "./component/http.ts": async () => await import("./component/http.js"),
  "./component/jobs.ts": async () => await import("./component/jobs.js"),
  "./component/operations.ts": async () => await import("./component/operations.js"),
  "./component/webhooks.ts": async () => await import("./component/webhooks.js"),
};

export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  name = "xquik",
): ComponentApi {
  return t.registerComponent<ComponentApi>(name, schema, modules);
}

export default { register, schema, modules };
