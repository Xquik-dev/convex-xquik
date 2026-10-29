import { check, readDelivery } from "./delivery.js";
import type { ActionCtx } from "./_generated/server.js";
import type { Delivery } from "./delivery.js";
import { httpAction } from "./_generated/server.js";
import { httpRouter } from "convex/server";
import type { HttpRouter } from "convex/server";
import { internal } from "./_generated/api.js";

const OK = 200;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const SLASH = "/";

type Runner = Readonly<Pick<ActionCtx, "runMutation" | "runQuery">>;

type Admission =
  | { readonly ok: true; readonly delivery: Delivery; readonly nonce: string }
  | { readonly ok: false; readonly reason: string; readonly status: number };

function reply(status: number, text: string): Response {
  return new Response(text, { headers: { "content-type": "text/plain" }, status });
}

function tokenOf(url: string): string {
  const { pathname } = new URL(url);
  return pathname.slice(pathname.lastIndexOf(SLASH) + SLASH.length);
}

async function admit(secret: string, headers: Readonly<Headers>, body: Readonly<ArrayBuffer>): Promise<Admission> {
  const verdict = await check(secret, headers, body, Date.now());
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason, status: UNAUTHORIZED };
  }
  const delivery = readDelivery(new TextDecoder().decode(body));
  if (delivery.kind === "invalid") {
    return { ok: false, reason: "not an Xquik delivery", status: BAD_REQUEST };
  }
  return { delivery, nonce: verdict.nonce, ok: true };
}

function answer(outcome: string): Response {
  if (outcome === "replay") {
    return reply(UNAUTHORIZED, "replayed nonce");
  }
  return reply(OK, outcome);
}

const receive = httpAction(async (ctx: Runner, request): Promise<Response> => {
  const endpoint = await ctx.runQuery(internal.webhooks.endpoint, { token: tokenOf(request.url) });
  if (!endpoint) {
    return reply(NOT_FOUND, "unknown webhook URL");
  }
  const admission = await admit(endpoint.secret, request.headers, await request.arrayBuffer());
  if (!admission.ok) {
    return reply(admission.status, admission.reason);
  }
  const { _id: endpointId } = endpoint;
  const { delivery, nonce } = admission;
  return answer(await ctx.runMutation(internal.webhooks.ingest, { delivery, endpointId, nonce }));
});

function router(): HttpRouter {
  const http = httpRouter();
  http.route({ handler: receive, method: "POST", pathPrefix: "/webhooks/" });
  return http;
}

export default router();
