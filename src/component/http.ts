import { httpRouter } from "convex/server";
import { internal } from "./_generated/api.js";
import { httpAction, type ActionCtx } from "./_generated/server.js";
import { check, readDelivery } from "./delivery.js";

function reply(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

export const receive = httpAction(async (ctx: ActionCtx, request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname;
  const endpoint = await ctx.runQuery(internal.webhooks.endpoint, { token: path.slice(path.lastIndexOf("/") + 1) });
  if (endpoint === null) return reply(404, "unknown webhook URL");
  const body = await request.arrayBuffer();
  const verdict = await check(endpoint.secret, request.headers, body, Date.now());
  if (!verdict.ok) return reply(401, verdict.reason);
  const delivery = readDelivery(new TextDecoder().decode(body));
  if (delivery === null) return reply(400, "not an Xquik delivery");
  const outcome = await ctx.runMutation(internal.webhooks.ingest, {
    endpointId: endpoint._id,
    nonce: verdict.nonce,
    event: delivery.kind === "test" ? null : delivery.event,
  });
  return outcome === "replay" ? reply(401, "replayed nonce") : reply(200, outcome);
});

const http = httpRouter();

http.route({ pathPrefix: "/webhooks/", method: "POST", handler: receive });

export default http;
