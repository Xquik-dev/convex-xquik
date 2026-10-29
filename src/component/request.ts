import { ConvexError } from "convex/values";
import { isRecord } from "./shape.js";
import type { Operation } from "./shape.js";
import { project } from "./registry.js";
import requireApiKey from "./access.js";
import { toValue } from "./values.js";
import type { Value } from "convex/values";

type Args = Readonly<Record<string, Value | undefined>>;
type Inputs = Readonly<Record<string, unknown>>;
type Stream = Readonly<Pick<ReadableStream<Uint8Array>, "getReader">>;
type Reader = Readonly<Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel" | "read">>;

interface Options {
  readonly apiKey: string | undefined;
  readonly streamMs: number;
}

const BASE_URL = "https://xquik.com";

const NO_RETRY_DELAY = 0;

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function url(operation: Operation, args: Inputs): URL {
  const path = operation.path.replaceAll(/\{(?<name>[^}]+)\}/gu, (_match, name: string) =>
    encodeURIComponent(text(args[name])),
  );
  const target = new URL(path, BASE_URL);
  for (const param of operation.params) {
    if (param.in === "query" && param.name in args) {
      for (const item of [args[param.name]].flat()) {
        target.searchParams.append(param.wire, text(item));
      }
    }
  }
  return target;
}

function headers(operation: Operation, args: Inputs, apiKey: string): Headers {
  const result = new Headers({ "user-agent": "xquik-convex", "x-api-key": apiKey });
  if (operation.body !== null) {
    result.set("content-type", "application/json");
  }
  for (const param of operation.params) {
    if (param.in === "header" && param.name in args) {
      result.set(param.wire, text(args[param.name]));
    }
  }
  return result;
}

function body(operation: Operation, args: Inputs): string | null {
  if (operation.body === null) {
    return null;
  }
  return JSON.stringify(Object.fromEntries(operation.body.map((name) => [name, args[name]])));
}

function parse(raw: string): Value {
  const value: unknown = JSON.parse(raw);
  return toValue(value);
}

function parseOrText(raw: string): Value {
  try {
    return parse(raw);
  } catch {
    return raw;
  }
}

function fieldOf(line: string): [string, string] {
  const name = line.replace(/:.*/su, "");
  return [name, line.slice(name.length + ":".length).replace(/^ /u, "")];
}

function event(block: string): Record<string, Value>[] {
  const lines = block.split(/\r?\n/u).map((line) => fieldOf(line));
  if (!lines.some(([name]) => name === "data")) {
    return [];
  }
  const payload = lines.filter(([name]) => name === "data").map(([, value]) => value);
  const entries: [string, Value][] = [
    ...lines.filter(([name]) => name === "id" || name === "event"),
    ["data", parseOrText(payload.join("\n"))],
  ];
  return [Object.fromEntries(entries)];
}

function events(raw: string): Value {
  return raw.split(/\r?\n\r?\n/u).flatMap((block) => event(block));
}

async function drain(reader: Reader, decoder: Readonly<TextDecoder>, raw: string): Promise<string> {
  const chunk = await reader.read();
  if (chunk.done) {
    return raw;
  }
  return await drain(reader, decoder, raw + decoder.decode(chunk.value, { stream: true }));
}

async function readEvents(stream: Stream | null, streamMs: number): Promise<Value> {
  if (stream === null) {
    return [];
  }
  const reader = stream.getReader();
  let cancelled = Promise.resolve();
  const timer = setTimeout(() => {
    cancelled = reader.cancel();
  }, streamMs);
  const raw = await drain(reader, new TextDecoder(), "");
  clearTimeout(timer);
  await cancelled;
  return events(raw);
}

function details(raw: string): [string, Value | undefined][] {
  const detail = parseOrText(raw);
  if (isRecord(detail)) {
    return Object.entries(detail);
  }
  return [["message", raw]];
}

function failure(raw: string, status: number, retryAfter: number): ConvexError<Value> {
  const entries: [string, Value | undefined][] = [...details(raw), ["status", status]];
  if (retryAfter > NO_RETRY_DELAY) {
    entries.push(["retryAfter", retryAfter]);
  }
  return new ConvexError(Object.fromEntries(entries));
}

function answer(operation: Operation, raw: string): Value {
  if (operation.response !== "json" || raw === "") {
    return null;
  }
  const value: unknown = JSON.parse(raw);
  return project(operation.result, value);
}

async function send(operation: Operation, args: Inputs, options: Options): Promise<Value> {
  const apiKey = requireApiKey(options.apiKey);
  const response = await fetch(url(operation, args), {
    body: body(operation, args),
    headers: headers(operation, args, apiKey),
    method: operation.method,
  });
  if (!response.ok) {
    throw failure(await response.text(), response.status, Number(response.headers.get("retry-after")));
  }
  if (operation.response === "bytes") {
    return await response.arrayBuffer();
  }
  if (operation.response === "events") {
    return await readEvents(response.body, options.streamMs);
  }
  return answer(operation, await response.text());
}

export * from "./registry.js";
export { BASE_URL, events, parse, parseOrText, send };
export type { Args, Options };
