import { ConvexError, v, type OptionalProperty, type Validator, type Value } from "convex/values";
import data from "./registry.json" with { type: "json" };
import { isRecord, parseRegistry, type Field, type Operation, type Shape } from "./shape.js";
import { json, toValue } from "./values.js";

export const registry = parseRegistry(data);

export const BASE_URL = "https://xquik.com";

const PRIMITIVES: Record<Extract<Shape, string>, Validator<Value, "required", string>> = {
  string: v.string(),
  number: v.number(),
  boolean: v.boolean(),
  null: v.null(),
  any: json,
};

export function validator(shape: Shape): Validator<Value, "required", string> {
  if (typeof shape === "string") return PRIMITIVES[shape];
  if ("literal" in shape) return v.literal(shape.literal);
  if ("array" in shape) return v.array(validator(shape.array));
  if ("record" in shape) return v.record(v.string(), validator(shape.record));
  if ("object" in shape) return v.object(fields(shape.object));
  return v.union(...shape.union.map(validator));
}

export type Fields = Record<string, Validator<Value | undefined, OptionalProperty, string>>;

function fieldValidator(field: Field): Validator<Value | undefined, OptionalProperty, string> {
  return field.optional ? v.optional(validator(field.shape)) : validator(field.shape);
}

export function fields(shape: Readonly<Record<string, Field>>): Fields {
  return Object.fromEntries(Object.entries(shape).map(([name, field]) => [name, fieldValidator(field)]));
}

export function find(id: string): Operation {
  const operation = registry[id];
  if (operation === undefined) {
    throw new ConvexError({ status: 404, error: "unknown_operation", message: `${id} is not an Xquik operation.` });
  }
  return operation;
}

export function argument(operation: Operation, name: string): Validator<Value | undefined, OptionalProperty, string> {
  const field = operation.args[name];
  if (field === undefined) throw new Error(`${operation.method} ${operation.path} has no argument ${name}.`);
  return fieldValidator(field);
}

export type Args = Readonly<Record<string, Value | undefined>>;

export interface Options {
  readonly apiKey: string | undefined;
  readonly streamMs: number;
}

function text(value: Value | undefined): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function url(operation: Operation, args: Args): URL {
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => encodeURIComponent(text(args[name])));
  const target = new URL(path, BASE_URL);
  for (const param of operation.params) {
    const value = args[param.name];
    if (param.in !== "query" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) target.searchParams.append(param.wire, text(item));
  }
  return target;
}

function headers(operation: Operation, args: Args, apiKey: string): Headers {
  const result = new Headers({ "x-api-key": apiKey, "user-agent": "convex-xquik" });
  if (operation.body !== null) result.set("content-type", "application/json");
  for (const param of operation.params) {
    const value = args[param.name];
    if (param.in === "header" && value !== undefined) result.set(param.wire, text(value));
  }
  return result;
}

function body(operation: Operation, args: Args): string | null {
  if (operation.body === null) return null;
  return JSON.stringify(Object.fromEntries(operation.body.map((name) => [name, args[name]])));
}

export function parse(raw: string): Value {
  const value: unknown = JSON.parse(raw);
  return toValue(value);
}

export function parseOrText(raw: string): Value {
  try {
    return parse(raw);
  } catch {
    return raw;
  }
}

export function events(raw: string): Value {
  return raw.split(/\r?\n\r?\n/).flatMap((block) => {
    const event: Record<string, string> = {};
    const lines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      const colon = line.includes(":") ? line.indexOf(":") : line.length;
      const field = line.slice(0, colon);
      const value = line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") lines.push(value);
      else if (field === "id" || field === "event") event[field] = value;
    }
    return lines.length === 0 ? [] : [{ ...event, data: parseOrText(lines.join("\n")) }];
  });
}

async function readEvents(response: Response, streamMs: number): Promise<Value> {
  const reader = response.body?.getReader();
  if (reader === undefined) return [];
  const decoder = new TextDecoder();
  const timer = setTimeout(() => void reader.cancel(), streamMs);
  let raw = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    raw += decoder.decode(chunk.value, { stream: true });
  }
  clearTimeout(timer);
  return events(raw);
}

async function failure(response: Response): Promise<ConvexError<Value>> {
  const raw = await response.text();
  const detail = parseOrText(raw);
  const known = isRecord(detail) ? detail : { message: raw };
  const retryAfter = Number(response.headers.get("retry-after"));
  return new ConvexError({ ...known, status: response.status, ...(retryAfter > 0 ? { retryAfter } : {}) });
}

export async function send(operation: Operation, args: Args, options: Options): Promise<Value> {
  if (options.apiKey === undefined || options.apiKey === "") {
    throw new ConvexError({
      status: 401,
      error: "missing_api_key",
      message: "Set XQUIK_API_KEY in the Convex dashboard and pass it to the xquik component in convex.config.ts.",
    });
  }
  const response = await fetch(url(operation, args), {
    method: operation.method,
    headers: headers(operation, args, options.apiKey),
    body: body(operation, args),
  });
  if (!response.ok) throw await failure(response);
  if (operation.response === "bytes") return await response.arrayBuffer();
  if (operation.response === "events") return await readEvents(response, options.streamMs);
  const raw = await response.text();
  return operation.response === "json" && raw !== "" ? parse(raw) : null;
}
