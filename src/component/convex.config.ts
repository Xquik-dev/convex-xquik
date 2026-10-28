import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("xquik", {
  env: { XQUIK_API_KEY: v.optional(v.string()) },
});
