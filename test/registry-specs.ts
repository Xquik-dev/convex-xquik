import type { Field, Registry } from "#src/component/shape.ts";
import { readRegistry } from "#scripts/registry.ts";

type Spec = Readonly<Record<string, unknown>>;

const CREATED: Spec = { 201: {} };

function spec(paths: Spec, schemas: Spec = {}): Spec {
  return { components: { schemas }, paths, security: [{ apiKey: [] }] };
}

function post(requestBody: unknown, responses: Spec = CREATED, parameters: readonly unknown[] = []): Spec {
  return { "/x": { post: { operationId: "make", parameters, requestBody, responses } } };
}

function json(schema: unknown, required = true): unknown {
  return { content: { "application/json": { schema } }, required };
}

function bodyRegistry(schema: unknown, schemas: Spec = {}): Registry {
  const paths = post(json(schema));
  return readRegistry(spec(paths, schemas));
}

function argsOf(registry: Registry): Readonly<Record<string, Field>>[] {
  return Object.values(registry.operations).map((operation) => operation.args);
}

export { argsOf, bodyRegistry, json, post, spec };
