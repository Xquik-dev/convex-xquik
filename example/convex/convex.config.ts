import type { AppDefinition } from "convex/server";
import { defineApp } from "convex/server";
import { v } from "convex/values";
import xquik from "xquik-convex/convex.config.js";

const env = { XQUIK_API_KEY: v.optional(v.string()) };

function exampleApp(): AppDefinition<typeof env> {
  const app = defineApp({ env });
  app.use(xquik, { env: { XQUIK_API_KEY: app.env.XQUIK_API_KEY }, httpPrefix: "/xquik/" });
  return app;
}

export default exampleApp();
