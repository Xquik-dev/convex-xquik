import { ConvexError } from "convex/values";

export default function requireApiKey(apiKey: string | undefined): string {
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new ConvexError({
      error: "missing_api_key",
      message: "Set XQUIK_API_KEY in the Convex dashboard and pass it to the xquik component in convex.config.ts.",
      status: 401,
    });
  }
  return apiKey;
}
