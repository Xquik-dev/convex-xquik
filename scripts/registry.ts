import { objectAt, stringsAt } from "./nodes.ts";
import { format } from "prettier";
import type { Options } from "prettier";
import prettierOptions from "#.prettierrc.json" with { type: "json" };
import Reader from "./reader.ts";
import type { Registry } from "#src/component/shape.ts";
import spec from "#openapi.json" with { type: "json" };

const METHODS = ["get", "put", "post", "patch", "delete"];

function byName<Value>(entries: readonly (readonly [string, Value])[]): (readonly [string, Value])[] {
  return entries.toSorted(([left], [right]) => left.localeCompare(right));
}

function readRegistry(source: unknown): Registry {
  const root = objectAt(source);
  const reader = new Reader(root);
  const entries = Object.entries(objectAt(root["paths"])).flatMap(([path, item]) =>
    METHODS.flatMap((method) => reader.entry(path, method, objectAt(item))),
  );
  return {
    operations: Object.fromEntries(byName(entries)),
    schemas: Object.fromEntries(byName(reader.named())),
  };
}

function eventTypes(source: unknown): string[] {
  const schemas = objectAt(objectAt(objectAt(source)["components"])["schemas"]);
  return ["EventType", "PostEventType"].flatMap((name) => stringsAt(objectAt(schemas[name])["enum"]));
}

async function registryJson(): Promise<string> {
  const options: Options = { parser: "json" };
  return await format(JSON.stringify(readRegistry(spec)), Object.assign(options, prettierOptions));
}

function operationsModule(): string {
  const names = Object.keys(readRegistry(spec).operations).map((id) => `  ${id},`);
  return ['import { operations } from "./operation.js";', "", "export const {", ...names, "} = operations();", ""].join(
    "\n",
  );
}

export { eventTypes, operationsModule, readRegistry, registryJson };
