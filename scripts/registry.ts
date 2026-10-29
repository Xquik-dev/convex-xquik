import { objectAt, stringsAt } from "./nodes.ts";
import { readFile, writeFile } from "node:fs/promises";
import Reader from "./reader.ts";
import type { Registry } from "#src/component/shape.ts";

const METHODS = ["get", "put", "post", "patch", "delete"];
const JSON_INDENT = 2;

function byName<Value>(entries: readonly (readonly [string, Value])[]): (readonly [string, Value])[] {
  return entries.toSorted(([left], [right]) => left.localeCompare(right));
}

function readRegistry(spec: unknown): Registry {
  const root = objectAt(spec);
  const reader = new Reader(root);
  const entries = Object.entries(objectAt(root["paths"])).flatMap(([path, item]) =>
    METHODS.flatMap((method) => reader.entry(path, method, objectAt(item))),
  );
  return {
    operations: Object.fromEntries(byName(entries)),
    schemas: Object.fromEntries(byName(reader.named())),
  };
}

function eventTypes(spec: unknown): string[] {
  const schemas = objectAt(objectAt(objectAt(spec)["components"])["schemas"]);
  return ["EventType", "PostEventType"].flatMap((name) => stringsAt(objectAt(schemas[name])["enum"]));
}

function renderOperations(registry: Registry): string {
  const names = Object.keys(registry.operations).map((id) => `  ${id},`);
  const lines = [
    'import { operations } from "./operation.js";',
    "",
    "export const {",
    ...names,
    "} = operations();",
    "",
  ];
  return lines.join("\n");
}

async function writeGenerated(root: string): Promise<void> {
  const spec: unknown = JSON.parse(await readFile(`${root}/openapi.json`, "utf8"));
  const registry = readRegistry(spec);
  await writeFile(`${root}/src/component/registry.json`, `${JSON.stringify(registry, null, JSON_INDENT)}\n`);
  await writeFile(`${root}/src/component/operations.ts`, renderOperations(registry));
}

export { eventTypes, readRegistry, renderOperations, writeGenerated };
