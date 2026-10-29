import { cronJobs } from "convex/server";
import type { Crons } from "convex/server";
import { internal } from "./_generated/api.js";

function schedule(): Crons {
  const crons = cronJobs();
  crons.interval("purge expired webhook nonces", { minutes: 10 }, internal.webhooks.purge, {});
  return crons;
}

export default schedule();
