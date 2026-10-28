import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isList,
  isRecord,
  type Field,
  type Operation,
  type Param,
  type Registry,
  type Response,
  type Shape,
} from "../src/component/shape.ts";

const METHODS = ["get", "put", "post", "patch", "delete"] as const;

function objectAt(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function listAt(value: unknown): readonly unknown[] {
  return isList(value) ? value : [];
}

function stringsAt(value: unknown): string[] {
  return listAt(value).filter((item) => typeof item === "string");
}

function camel(header: string): string {
  return header.toLowerCase().replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function same(left: Shape, right: Shape): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function union(members: Shape[]): Shape {
  const flat = members.flatMap((member) => (typeof member === "object" && "union" in member ? member.union : [member]));
  const unique = flat.filter((member, index) => flat.findIndex((other) => same(member, other)) === index);
  if (unique.includes("any")) return "any";
  const [first, ...rest] = unique;
  return first !== undefined && rest.length === 0 ? first : { union: unique };
}

function literal(value: unknown): Shape {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return { literal: value };
  throw new Error(`openapi.json has the enum value ${JSON.stringify(value)}, which no validator can hold.`);
}

export function readRegistry(spec: unknown): Registry {
  const root = objectAt(spec);

  function resolve(value: unknown, seen: readonly string[] = []): Readonly<Record<string, unknown>> {
    const node = objectAt(value);
    const ref = node["$ref"];
    if (typeof ref !== "string") return node;
    if (seen.includes(ref)) throw new Error(`openapi.json has the reference cycle ${[...seen, ref].join(" > ")}.`);
    const target = ref
      .slice(2)
      .split("/")
      .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<unknown>((parent, token) => objectAt(parent)[token], root);
    if (target === undefined) throw new Error(`openapi.json has the broken reference ${ref}.`);
    return resolve(target, [...seen, ref]);
  }

  function fields(node: Readonly<Record<string, unknown>>, optional: boolean): Record<string, Field> {
    const required = stringsAt(node["required"]);
    return Object.fromEntries(
      Object.entries(objectAt(node["properties"])).map(([name, value]) => [
        name,
        { shape: shape(value), optional: optional || !required.includes(name) },
      ]),
    );
  }

  function objects(id: string, members: readonly Shape[]): Readonly<Record<string, Field>>[] {
    return members.map((member) => {
      if (typeof member === "object" && "object" in member) return member.object;
      throw new Error(`${id} has ${JSON.stringify(member)} where it needs an object.`);
    });
  }

  function combine(parts: Readonly<Record<string, Field>>[], everyPart: boolean): Record<string, Field> {
    const names = [...new Set(parts.flatMap((part) => Object.keys(part)))];
    return Object.fromEntries(
      names.map((name) => {
        const present = parts.flatMap((part) => part[name] ?? []);
        const optional = everyPart
          ? present.every((field) => field.optional)
          : present.length < parts.length || present.some((field) => field.optional);
        return [name, { shape: union(present.map((field) => field.shape)), optional }];
      }),
    );
  }

  function typed(node: Readonly<Record<string, unknown>>, type: string): Shape {
    if (type === "string") return "string";
    if (type === "number" || type === "integer") return "number";
    if (type === "boolean") return "boolean";
    if (type === "null") return "null";
    if (type === "array") return { array: shape(node["items"]) };
    return objectShape(node);
  }

  function objectShape(node: Readonly<Record<string, unknown>>): Shape {
    if (node["properties"] !== undefined) return { object: fields(node, false) };
    const extra = node["additionalProperties"];
    return isRecord(extra) ? { record: shape(extra) } : "any";
  }

  function shape(value: unknown): Shape {
    const node = resolve(value);
    if (node["const"] !== undefined) return literal(node["const"]);
    if (node["enum"] !== undefined) return union(listAt(node["enum"]).map(literal));
    const variants = [...listAt(node["oneOf"]), ...listAt(node["anyOf"])];
    if (variants.length > 0) return union(variants.map(shape));
    const parts = listAt(node["allOf"]);
    if (parts.length > 0) return { object: combine(objects("An allOf", parts.map(shape)), true) };
    if (node["type"] === undefined) return objectShape(node);
    const types = [node["type"]].flat().filter((type) => typeof type === "string");
    return union(types.map((type) => typed(node, type)));
  }

  function response(op: Readonly<Record<string, unknown>>): Response {
    const responses = objectAt(op["responses"]);
    const success = Object.keys(responses).filter((code) => code.startsWith("2"));
    const types = success.flatMap((code) => Object.keys(objectAt(resolve(responses[code])["content"])));
    if (types.includes("application/json")) return "json";
    if (types.includes("application/octet-stream")) return "bytes";
    if (types.includes("text/event-stream")) return "events";
    return "none";
  }

  function isPublic(security: unknown): boolean {
    return listAt(security).some((requirement) => {
      const schemes = Object.keys(objectAt(requirement));
      return schemes.length === 0 || schemes.includes("apiKey");
    });
  }

  function entry(
    path: string,
    method: (typeof METHODS)[number],
    item: Readonly<Record<string, unknown>>,
  ): [string, Operation][] {
    const op = objectAt(item[method]);
    const id = op["operationId"];
    if (typeof id !== "string" || !isPublic(op["security"] ?? root["security"])) return [];
    const params: Param[] = [];
    const args: Record<string, Field> = {};
    for (const raw of [...listAt(item["parameters"]), ...listAt(op["parameters"])]) {
      const param = resolve(raw);
      const wire = param["name"];
      const location = param["in"];
      if (typeof wire !== "string" || (location !== "path" && location !== "query" && location !== "header")) continue;
      const name = location === "header" ? camel(wire) : wire;
      params.push({ name, in: location, wire });
      args[name] = { shape: shape(param["schema"]), optional: param["required"] !== true };
    }
    const requestBody = resolve(op["requestBody"]);
    const schema = objectAt(objectAt(requestBody["content"])["application/json"])["schema"];
    const body = schema === undefined ? null : shape(schema);
    const variants =
      body !== null && typeof body === "object" && "union" in body ? body.union : [body ?? { object: {} }];
    const bodyFields = combine(objects(id, variants), false);
    for (const [name, field] of Object.entries(bodyFields)) {
      if (args[name] !== undefined) throw new Error(`${id} has a parameter and a body field both named ${name}.`);
      args[name] = { shape: field.shape, optional: field.optional || requestBody["required"] !== true };
    }
    return [
      [
        id,
        {
          method: method.toUpperCase(),
          path,
          params,
          body: body === null ? null : Object.keys(bodyFields),
          response: response(op),
          args,
        },
      ],
    ];
  }

  const entries = Object.entries(objectAt(root["paths"])).flatMap(([path, item]) =>
    METHODS.flatMap((method) => entry(path, method, objectAt(item))),
  );
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export function eventTypes(spec: unknown): string[] {
  const schemas = objectAt(objectAt(objectAt(spec)["components"])["schemas"]);
  return ["EventType", "PostEventType"].flatMap((name) => stringsAt(objectAt(schemas[name])["enum"]));
}

export function renderOperations(registry: Registry): string {
  const lines = Object.keys(registry).map((id) => `export const ${id} = operation(${JSON.stringify(id)});`);
  return ['import { operation } from "./operation.js";', "", ...lines, ""].join("\n");
}

export function writeGenerated(root: string): void {
  const spec: unknown = JSON.parse(readFileSync(join(root, "openapi.json")).toString());
  const registry = readRegistry(spec);
  writeFileSync(join(root, "src/component/registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
  writeFileSync(join(root, "src/component/operations.ts"), renderOperations(registry));
}
