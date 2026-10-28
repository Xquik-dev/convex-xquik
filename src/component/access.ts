import { ConvexError } from "convex/values";

export function requireApiKey(apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === "") {
    throw new ConvexError({
      status: 401,
      error: "missing_api_key",
      message: "Set XQUIK_API_KEY in the Convex dashboard and pass it to the xquik component in convex.config.ts.",
    });
  }
  return apiKey;
}
