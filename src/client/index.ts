import {
  createFunctionHandle,
  type FunctionArgs,
  type FunctionReference,
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

type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runAction">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;

export type EventHandler = FunctionReference<"mutation", "internal" | "public", { event: EventFields }>;

export type EventTypes = FunctionArgs<ComponentApi["webhooks"]["create"]>["eventTypes"];

export interface Schedule {
  readonly key?: string;
  readonly everyMs?: number;
  readonly delayMs?: number;
}

export class Xquik {
  readonly component: ComponentApi;

  constructor(component: ComponentApi) {
    this.component = component;
  }

  async schedule<Name extends OperationName>(
    ctx: MutationCtx,
    operation: Name,
    args: OperationArgs<Name>,
    options: Schedule = {},
  ): Promise<string> {
    return await ctx.runMutation(this.component.jobs.enqueue, { operation, args, ...options });
  }

  async createWebhook(
    ctx: ActionCtx,
    args: { readonly eventTypes: EventTypes; readonly onEvent?: EventHandler },
  ): Promise<{ endpointId: string; url: string; webhookId: string }> {
    const onEvent = args.onEvent === undefined ? {} : { onEvent: await createFunctionHandle(args.onEvent) };
    return await ctx.runAction(this.component.webhooks.create, { eventTypes: args.eventTypes, ...onEvent });
  }

  async addWebhook(
    ctx: MutationCtx,
    args: { readonly secret: string; readonly onEvent?: EventHandler },
  ): Promise<{ endpointId: string; url: string }> {
    const onEvent = args.onEvent === undefined ? {} : { onEvent: await createFunctionHandle(args.onEvent) };
    return await ctx.runMutation(this.component.webhooks.add, { secret: args.secret, ...onEvent });
  }
}
