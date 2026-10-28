export type Shape =
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

export interface Field {
  readonly shape: Shape;
  readonly optional: boolean;
  readonly wire?: string;
}

export interface Param {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly wire: string;
}

export type Response = "json" | "bytes" | "events" | "none";

export interface Operation {
  readonly method: string;
  readonly path: string;
  readonly params: readonly Param[];
  readonly body: readonly string[] | null;
  readonly response: Response;
  readonly args: Readonly<Record<string, Field>>;
  readonly result: Shape;
}

export interface Registry {
  readonly operations: Readonly<Record<string, Operation>>;
  readonly schemas: Readonly<Record<string, Shape>>;
}

const PRIMITIVES = new Set(["string", "number", "boolean", "null", "bytes", "any"]);
const LOCATIONS: ReadonlySet<unknown> = new Set(["path", "query", "header"]);
const RESPONSES: ReadonlySet<unknown> = new Set(["json", "bytes", "events", "none"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !isList(value);
}

export function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return isList(value) && value.every((item) => typeof item === "string");
}

function isFields(value: unknown): value is Record<string, Field> {
  return isRecord(value) && Object.values(value).every(isField);
}

function isField(value: unknown): value is Field {
  return (
    isRecord(value) &&
    typeof value["optional"] === "boolean" &&
    ["string", "undefined"].includes(typeof value["wire"]) &&
    isShape(value["shape"])
  );
}

function isShapeEntry([kind, inner]: [string, unknown]): boolean {
  if (kind === "literal") return ["string", "number", "boolean"].includes(typeof inner);
  if (kind === "ref") return typeof inner === "string";
  if (kind === "array" || kind === "record") return isShape(inner);
  if (kind === "object") return isFields(inner);
  return kind === "union" && isList(inner) && inner.every(isShape);
}

export function isShape(value: unknown): value is Shape {
  if (typeof value === "string") return PRIMITIVES.has(value);
  if (!isRecord(value)) return false;
  const [entry, ...rest] = Object.entries(value);
  return entry !== undefined && rest.length === 0 && isShapeEntry(entry);
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
    (value["body"] === null || isStrings(value["body"])) &&
    RESPONSES.has(value["response"]) &&
    isFields(value["args"]) &&
    isShape(value["result"])
  );
}

function isRegistry(value: unknown): value is Registry {
  return (
    isRecord(value) &&
    isRecord(value["operations"]) &&
    Object.values(value["operations"]).every(isOperation) &&
    isRecord(value["schemas"]) &&
    Object.values(value["schemas"]).every(isShape)
  );
}

export function parseRegistry(value: unknown): Registry {
  if (isRegistry(value)) return value;
  throw new Error("The operation registry is malformed. Run npm run generate.");
}
