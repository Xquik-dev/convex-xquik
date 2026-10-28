import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.interval("purge expired webhook nonces", { minutes: 10 }, internal.webhooks.purge, {});

export default crons;
