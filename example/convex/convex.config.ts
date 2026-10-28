import { defineApp } from "convex/server";
import { v } from "convex/values";
import xquik from "convex-xquik/convex.config.js";

const app = defineApp({ env: { XQUIK_API_KEY: v.optional(v.string()) } });

app.use(xquik, { httpPrefix: "/xquik/", env: { XQUIK_API_KEY: app.env.XQUIK_API_KEY } });

export default app;
