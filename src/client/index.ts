import {
  createFunctionHandle,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { v, type Infer } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import { eventFields, type EventFields } from "../component/values.js";

export { eventFields, type EventFields };

export const eventDoc = eventFields.extend({ _id: v.string(), _creationTime: v.number() });

export type EventDoc = Infer<typeof eventDoc>;

export type OperationName = keyof ComponentApi["operations"];

export type OperationArgs<Name extends OperationName> = FunctionArgs<ComponentApi["operations"][Name]>;

export type OperationResult<Name extends OperationName> = FunctionReturnType<ComponentApi["operations"][Name]>;

type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runAction">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;

export type EventHandler = FunctionReference<"mutation", "internal" | "public", { event: EventFields }>;

export type EventTypes = FunctionArgs<ComponentApi["webhooks"]["create"]>["eventTypes"];

export interface Schedule {
  readonly key?: string;
  readonly everyMs?: number;
  readonly delayMs?: number;
}

/** Calls the Xquik component from your app's mutations and actions. */
export class Xquik {
  readonly component: ComponentApi;

  /**
   * @param component The mounted component, `components.xquik` from `./_generated/api`.
   */
  constructor(component: ComponentApi) {
    this.component = component;
  }

  /**
   * Schedules an operation as a durable job and returns its job ID.
   *
   * While a job with the same `key` is scheduled or running, the call returns that job's ID.
   * Reads and writes that take an `Idempotency-Key` retry on a 429, a 5xx or a network error.
   *
   * @param operation The operation name, such as `"getUser"`.
   * @param args The operation's arguments, typed from its schema.
   * @param options `key` keeps 1 scheduled job per key. `everyMs` repeats the job, at 60,000 ms or more.
   * `delayMs` starts it later.
   */
  async schedule<Name extends OperationName>(
    ctx: MutationCtx,
    operation: Name,
    args: OperationArgs<Name>,
    options: Schedule = {},
  ): Promise<string> {
    return await ctx.runMutation(this.component.jobs.enqueue, { operation, args, ...options });
  }

  /**
   * Creates an Xquik webhook for the event types and an endpoint in the component that receives it.
   *
   * @param args `eventTypes` to deliver, and `onEvent`, a mutation that runs after each new delivery to this endpoint.
   * @returns The endpoint ID, its URL and the Xquik webhook ID.
   */
  async createWebhook(
    ctx: ActionCtx,
    args: { readonly eventTypes: EventTypes; readonly onEvent?: EventHandler },
  ): Promise<{ endpointId: string; url: string; webhookId: string }> {
    const onEvent = args.onEvent === undefined ? {} : { onEvent: await createFunctionHandle(args.onEvent) };
    return await ctx.runAction(this.component.webhooks.create, { eventTypes: args.eventTypes, ...onEvent });
  }

  /**
   * Adds an endpoint for a webhook you created elsewhere, with its signing secret.
   *
   * @param args The webhook's `secret`, and `onEvent`, a mutation that runs after each new delivery to this endpoint.
   * @returns The endpoint ID and the URL to give Xquik.
   */
  async addWebhook(
    ctx: MutationCtx,
    args: { readonly secret: string; readonly onEvent?: EventHandler },
  ): Promise<{ endpointId: string; url: string }> {
    const onEvent = args.onEvent === undefined ? {} : { onEvent: await createFunctionHandle(args.onEvent) };
    return await ctx.runMutation(this.component.webhooks.add, { secret: args.secret, ...onEvent });
  }
}
