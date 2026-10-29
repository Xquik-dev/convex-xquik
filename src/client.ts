import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
} from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
import { createFunctionHandle } from "convex/server";
import type { EventFields } from "./component/values.js";
import type { Infer } from "convex/values";
import schema from "./component/schema.js";
import { v } from "convex/values";

const eventDoc = schema.tables.events.validator.extend({ _creationTime: v.number(), _id: v.string() });

type EventDoc = Infer<typeof eventDoc>;

type OperationName = keyof ComponentApi["operations"];

type OperationArgs<Name extends OperationName> = FunctionArgs<ComponentApi["operations"][Name]>;

type OperationResult<Name extends OperationName> = FunctionReturnType<ComponentApi["operations"][Name]>;

type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runAction">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;

type EventHandler = FunctionReference<"mutation", "internal" | "public", { event: EventFields }>;

type EventTypes = FunctionArgs<ComponentApi["webhooks"]["create"]>["eventTypes"];

interface Schedule {
  readonly key?: string;
  readonly everyMs?: number;
  readonly delayMs?: number;
}

/** Calls the Xquik component from your app's mutations and actions. */
class Xquik {
  public readonly component: ComponentApi;

  /**
   * @param {ComponentApi} component The mounted component, `components.xquik` from `./_generated/api`.
   */
  public constructor(component: ComponentApi) {
    this.component = component;
  }

  /**
   * Schedules an operation as a durable job and returns its job ID.
   *
   * While a job with the same `key` is scheduled or running, the call returns that job's ID.
   * Reads and writes that take an `Idempotency-Key` retry on a 429, a 5xx or a network error.
   *
   * @param {MutationCtx} ctx The mutation context that schedules the job.
   * @param {Name} operation The operation name, such as `"getUser"`.
   * @param {OperationArgs<Name>} args The operation's arguments, typed from its schema.
   * @param {Schedule} [options] `key` keeps 1 scheduled job per key. `everyMs` repeats the job, at 60,000 ms or more.
   * `delayMs` starts it later.
   * @returns {Promise<string>} The job ID.
   */
  public async schedule<Name extends OperationName>(
    ctx: MutationCtx,
    operation: Name,
    args: OperationArgs<Name>,
    options: Schedule = {},
  ): Promise<string> {
    const job = { args, operation };
    return await ctx.runMutation(this.component.jobs.enqueue, Object.assign(job, options));
  }

  /**
   * Creates an Xquik webhook for the event types and an endpoint in the component that receives it.
   *
   * @param {ActionCtx} ctx The action context that calls Xquik.
   * @param {{ eventTypes: EventTypes, onEvent?: EventHandler }} args `eventTypes` to deliver, and `onEvent`, a mutation that runs once for each `streamEventId` this endpoint receives. A retry or the `webhook.test` alert does not run it.
   * @returns {Promise<{ endpointId: string, url: string, webhookId: string }>} The endpoint ID, its URL and the Xquik webhook ID.
   */
  public async createWebhook(
    ctx: ActionCtx,
    args: {
      readonly eventTypes: Readonly<EventTypes>;
      readonly onEvent?: FunctionReference<"mutation", "internal" | "public", { event: EventFields }>;
    },
  ): Promise<{ endpointId: string; url: string; webhookId: string }> {
    const eventTypes = [...args.eventTypes];
    if (typeof args.onEvent !== "object") {
      return await ctx.runAction(this.component.webhooks.create, { eventTypes });
    }
    return await ctx.runAction(this.component.webhooks.create, {
      eventTypes,
      onEvent: await createFunctionHandle(args.onEvent),
    });
  }

  /**
   * Adds an endpoint for a webhook you created elsewhere, with its signing secret.
   *
   * @param {MutationCtx} ctx The mutation context that stores the endpoint.
   * @param {{ secret: string, onEvent?: EventHandler }} args The webhook's `secret`, and `onEvent`, a mutation that runs once for each `streamEventId` this endpoint receives. A retry or the `webhook.test` alert does not run it.
   * @returns {Promise<{ endpointId: string, url: string }>} The endpoint ID and the URL to give Xquik.
   */
  public async addWebhook(
    ctx: MutationCtx,
    args: {
      readonly secret: string;
      readonly onEvent?: FunctionReference<"mutation", "internal" | "public", { event: EventFields }>;
    },
  ): Promise<{ endpointId: string; url: string }> {
    const { onEvent, secret } = args;
    if (typeof onEvent !== "object") {
      return await ctx.runMutation(this.component.webhooks.add, { secret });
    }
    return await ctx.runMutation(this.component.webhooks.add, { onEvent: await createFunctionHandle(onEvent), secret });
  }
}

export { eventDoc, Xquik };
export { eventFields, type EventFields } from "./component/values.js";
export type { EventDoc, EventHandler, EventTypes, OperationArgs, OperationName, OperationResult, Schedule };
