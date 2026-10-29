import nothing from "./none.json" with { type: "json" };

type Shape =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "bytes"
  | "any"
  | { readonly literal: string | number | boolean }
  | { readonly array: Shape }
  | { readonly object: Readonly<Record<string, Field>> }
  | { readonly record: Shape }
  | { readonly union: readonly Shape[] }
  | { readonly ref: string };

interface Field {
  readonly shape: Shape;
  readonly optional: boolean;
  readonly wire?: string;
}

interface Param {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly wire: string;
}

type Response = "json" | "bytes" | "events" | "none";

interface Operation {
  readonly method: string;
  readonly path: string;
  readonly params: readonly Param[];
  readonly body: readonly string[] | null;
  readonly response: Response;
  readonly args: Readonly<Record<string, Field>>;
  readonly result: Shape;
}

interface Registry {
  readonly operations: Readonly<Record<string, Operation>>;
  readonly schemas: Readonly<Record<string, Shape>>;
}

const PRIMITIVES = new Set(["string", "number", "boolean", "null", "bytes", "any"]);
const LOCATIONS: ReadonlySet<unknown> = new Set(["path", "query", "header"]);
const RESPONSES: ReadonlySet<unknown> = new Set(["json", "bytes", "events", "none"]);
const SHAPE_KINDS = 1;

const none: null = nothing;

function isNull(value: unknown): value is null {
  return typeof value === "object" && !value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && !isNull(value) && !isList(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return isList(value) && value.every((item) => typeof item === "string");
}

function isFields(value: unknown): value is Record<string, Field> {
  return isRecord(value) && Object.values(value).every((field) => isField(field));
}

function isField(value: unknown): value is Field {
  return (
    isRecord(value) &&
    typeof value["optional"] === "boolean" &&
    ["string", "undefined"].includes(typeof value["wire"]) &&
    isShape(value["shape"])
  );
}

function isShapeEntry([kind, inner]: readonly [string, unknown]): boolean {
  if (kind === "literal") {
    return ["string", "number", "boolean"].includes(typeof inner);
  }
  if (kind === "ref") {
    return typeof inner === "string";
  }
  if (kind === "array" || kind === "record") {
    return isShape(inner);
  }
  if (kind === "object") {
    return isFields(inner);
  }
  return kind === "union" && isList(inner) && inner.every((shape) => isShape(shape));
}

function isSingleEntry(
  entries: readonly (readonly [string, unknown])[],
): entries is readonly [readonly [string, unknown]] {
  return entries.length === SHAPE_KINDS;
}

function isShape(value: unknown): value is Shape {
  if (typeof value === "string") {
    return PRIMITIVES.has(value);
  }
  if (!isRecord(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return isSingleEntry(entries) && isShapeEntry(entries[0]);
}

function isParam(value: unknown): value is Param {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["wire"] === "string" &&
    LOCATIONS.has(value["in"])
  );
}

function isOperation(value: unknown): value is Operation {
  return (
    isRecord(value) &&
    typeof value["method"] === "string" &&
    typeof value["path"] === "string" &&
    isList(value["params"]) &&
    value["params"].every(isParam) &&
    (isNull(value["body"]) || isStrings(value["body"])) &&
    RESPONSES.has(value["response"]) &&
    isFields(value["args"]) &&
    isShape(value["result"])
  );
}

function isRegistry(value: unknown): value is Registry {
  return (
    isRecord(value) &&
    isRecord(value["operations"]) &&
    Object.values(value["operations"]).every((operation) => isOperation(operation)) &&
    isRecord(value["schemas"]) &&
    Object.values(value["schemas"]).every((shape) => isShape(shape))
  );
}

function parseRegistry(value: unknown): Registry {
  if (isRegistry(value)) {
    return value;
  }
  throw new Error("The operation registry is malformed. Run npm run generate.");
}

export { isList, isNull, isRecord, isShape, none, parseRegistry };
export type { Field, Operation, Param, Registry, Response, Shape };
