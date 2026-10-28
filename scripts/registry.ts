import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isList,
  isRecord,
  type Field,
  type Operation,
  type Param,
  type Registry,
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

const SCHEMAS = "#/components/schemas/";

const EVENTS: Shape = {
  array: {
    object: {
      id: { shape: "string", optional: true },
      event: { shape: "string", optional: true },
      data: { shape: "any", optional: false },
    },
  },
};

type Node = Readonly<Record<string, unknown>>;

function merge(left: Node, right: Node): Node {
  const properties: Record<string, unknown> = { ...objectAt(left["properties"]) };
  for (const [name, schema] of Object.entries(objectAt(right["properties"]))) {
    const known = properties[name];
    properties[name] = known === undefined ? schema : { allOf: [known, schema] };
  }
  const merged = { ...left, ...right, required: [...stringsAt(left["required"]), ...stringsAt(right["required"])] };
  return left["properties"] === undefined && right["properties"] === undefined ? merged : { ...merged, properties };
}

export function readRegistry(spec: unknown): Registry {
  const root = objectAt(spec);
  const schemas = new Map<string, Shape>();
  const building: string[] = [];

  function pointer(ref: string): Node {
    const target = ref
      .slice(2)
      .split("/")
      .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<unknown>((parent, token) => objectAt(parent)[token], root);
    if (target === undefined) throw new Error(`openapi.json has the broken reference ${ref}.`);
    return objectAt(target);
  }

  function resolve(value: unknown, seen: readonly string[] = []): Node {
    const node = objectAt(value);
    const ref = node["$ref"];
    if (typeof ref !== "string") return node;
    if (seen.includes(ref)) throw new Error(`openapi.json has the reference cycle ${[...seen, ref].join(" > ")}.`);
    return resolve(pointer(ref), [...seen, ref]);
  }

  function build(name: string): Shape {
    const ref = SCHEMAS + name;
    if (building.includes(ref)) {
      throw new Error(`openapi.json has the reference cycle ${[...building, ref].join(" > ")}.`);
    }
    const known = schemas.get(name);
    if (known !== undefined) return known;
    building.push(ref);
    const built = shape(pointer(ref));
    building.pop();
    schemas.set(name, built);
    return built;
  }

  function deref(value: Shape): Shape {
    return typeof value === "object" && "ref" in value ? deref(build(value.ref)) : value;
  }

  function flatten({ allOf, ...node }: Node): Node {
    return listAt(allOf)
      .map((part) => flatten(resolve(part)))
      .reduce(merge, node);
  }

  function fields(node: Node, optional: boolean): Record<string, Field> {
    const required = stringsAt(node["required"]);
    return Object.fromEntries(
      Object.entries(objectAt(node["properties"])).map(([wire, value]) => {
        const field = { shape: shape(value), optional: optional || !required.includes(wire) };
        const name = wire.replace(/^@/, "");
        return [name, name === wire ? field : { ...field, wire }];
      }),
    );
  }

  function objects(id: string, members: readonly Shape[]): Readonly<Record<string, Field>>[] {
    return members.map(deref).map((member) => {
      if (typeof member === "object" && "object" in member) return member.object;
      throw new Error(`${id} has ${JSON.stringify(member)} where it needs an object.`);
    });
  }

  function combine(parts: Readonly<Record<string, Field>>[]): Record<string, Field> {
    const names = [...new Set(parts.flatMap((part) => Object.keys(part)))];
    return Object.fromEntries(
      names.map((name) => {
        const present = parts.flatMap((part) => part[name] ?? []);
        const optional = present.length < parts.length || present.some((field) => field.optional);
        return [name, { shape: union(present.map((field) => field.shape)), optional }];
      }),
    );
  }

  function typed(node: Node, type: string): Shape {
    if (type === "string") return "string";
    if (type === "number" || type === "integer") return "number";
    if (type === "boolean") return "boolean";
    if (type === "null") return "null";
    if (type === "array") return { array: shape(node["items"]) };
    return objectShape(node);
  }

  function objectShape(node: Node): Shape {
    if (node["properties"] !== undefined) return { object: fields(node, false) };
    const extra = node["additionalProperties"];
    return isRecord(extra) ? { record: shape(extra) } : "any";
  }

  function nodeShape(raw: Node): Shape {
    const { oneOf, anyOf, ...node } = flatten(raw);
    if (node["const"] !== undefined) return literal(node["const"]);
    if (node["enum"] !== undefined) return union(listAt(node["enum"]).map(literal));
    const variants = [...listAt(oneOf), ...listAt(anyOf)];
    if (variants.length > 0) {
      if (node["properties"] === undefined && node["required"] === undefined) return union(variants.map(shape));
      return union(variants.map((variant) => nodeShape(merge(node, flatten(resolve(variant))))));
    }
    if (node["type"] === undefined) return objectShape(node);
    const types = [node["type"]].flat().filter((type) => typeof type === "string");
    return union(types.map((type) => typed(node, type)));
  }

  function shape(value: unknown): Shape {
    const node = objectAt(value);
    const ref = node["$ref"];
    if (typeof ref !== "string" || !ref.startsWith(SCHEMAS)) return nodeShape(resolve(node));
    const name = ref.slice(SCHEMAS.length);
    build(name);
    return { ref: name };
  }

  function outcome(op: Node): Pick<Operation, "response" | "result"> {
    const responses = objectAt(op["responses"]);
    const contents = Object.keys(responses)
      .filter((code) => code.startsWith("2"))
      .map((code) => objectAt(resolve(responses[code])["content"]));
    const types = contents.flatMap((content) => Object.keys(content));
    if (types.includes("application/json")) {
      const results = contents.map((content) => {
        const media = content["application/json"];
        return media === undefined ? "null" : shape(objectAt(media)["schema"]);
      });
      return { response: "json", result: union(results) };
    }
    if (types.includes("application/octet-stream")) return { response: "bytes", result: "bytes" };
    if (types.includes("text/event-stream")) return { response: "events", result: EVENTS };
    return { response: "none", result: "null" };
  }

  function isPublic(security: unknown): boolean {
    return listAt(security).some((requirement) => {
      const schemes = Object.keys(objectAt(requirement));
      return schemes.length === 0 || schemes.includes("apiKey");
    });
  }

  function entry(path: string, method: (typeof METHODS)[number], item: Node): [string, Operation][] {
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
    const body = schema === undefined ? null : deref(shape(schema));
    const variants =
      body !== null && typeof body === "object" && "union" in body ? body.union : [body ?? { object: {} }];
    const bodyFields = combine(objects(id, variants));
    for (const [name, field] of Object.entries(bodyFields)) {
      if (args[name] !== undefined) throw new Error(`${id} has a parameter and a body field both named ${name}.`);
      args[name] = { shape: field.shape, optional: field.optional || requestBody["required"] !== true };
    }
    const operation = {
      method: method.toUpperCase(),
      path,
      params,
      body: body === null ? null : Object.keys(bodyFields),
    };
    return [[id, { ...operation, ...outcome(op), args }]];
  }

  const entries = Object.entries(objectAt(root["paths"])).flatMap(([path, item]) =>
    METHODS.flatMap((method) => entry(path, method, objectAt(item))),
  );
  const byName = ([left]: [string, unknown], [right]: [string, unknown]): number => left.localeCompare(right);
  return {
    operations: Object.fromEntries(entries.sort(byName)),
    schemas: Object.fromEntries([...schemas].sort(byName)),
  };
}

export function eventTypes(spec: unknown): string[] {
  const schemas = objectAt(objectAt(objectAt(spec)["components"])["schemas"]);
  return ["EventType", "PostEventType"].flatMap((name) => stringsAt(objectAt(schemas[name])["enum"]));
}

export function renderOperations(registry: Registry): string {
  const lines = Object.keys(registry.operations).map((id) => `export const ${id} = operation(${JSON.stringify(id)});`);
  return ['import { operation } from "./operation.js";', "", ...lines, ""].join("\n");
}

export function writeGenerated(root: string): void {
  const spec: unknown = JSON.parse(readFileSync(join(root, "openapi.json")).toString());
  const registry = readRegistry(spec);
  writeFileSync(join(root, "src/component/registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
  writeFileSync(join(root, "src/component/operations.ts"), renderOperations(registry));
}
