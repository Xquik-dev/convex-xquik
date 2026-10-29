import type { Field, Param, Shape } from "#src/component/shape.ts";
import { isList, isNull, isRecord, none } from "#src/component/shape.ts";

type Node = Readonly<Record<string, unknown>>;

type Fields = Readonly<Record<string, Field>>;

interface Argument {
  readonly field: Field;
  readonly param: Param;
}

const SINGLE_MEMBER = 1;
const NO_SCHEMES = 0;
const LOCATIONS: ReadonlySet<unknown> = new Set(["path", "query", "header"]);

function objectAt(value: unknown): Node {
  if (isRecord(value)) {
    return value;
  }
  return {};
}

function listAt(value: unknown): readonly unknown[] {
  if (isList(value)) {
    return value;
  }
  return [];
}

function stringsAt(value: unknown): string[] {
  return listAt(value).filter((item) => typeof item === "string");
}

function without(node: Node, names: readonly string[]): Node {
  return Object.fromEntries(Object.entries(node).filter(([name]) => !names.includes(name)));
}

function camel(header: string): string {
  return header.toLowerCase().replaceAll(/-(?<letter>[a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function argumentName(location: Param["in"], wire: string): string {
  if (location === "header") {
    return camel(wire);
  }
  return wire;
}

function isLocation(value: unknown): value is Param["in"] {
  return LOCATIONS.has(value);
}

function isPublic(security: unknown): boolean {
  return listAt(security).some((requirement) => {
    const schemes = Object.keys(objectAt(requirement));
    return schemes.length === NO_SCHEMES || schemes.includes("apiKey");
  });
}

function same(left: Shape, right: Shape): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSingle(shapes: readonly Shape[]): shapes is readonly [Shape] {
  return shapes.length === SINGLE_MEMBER;
}

function members(shape: Shape): readonly Shape[] {
  if (typeof shape === "object" && "union" in shape) {
    return shape.union;
  }
  return [shape];
}

function union(shapes: readonly Shape[]): Shape {
  const flat = shapes.flatMap((shape) => members(shape));
  const unique = flat.filter((member, index) => flat.findIndex((other) => same(member, other)) === index);
  if (unique.includes("any")) {
    return "any";
  }
  if (isSingle(unique)) {
    const [only] = unique;
    return only;
  }
  return { union: unique };
}

function literal(value: unknown): Shape {
  if (isNull(value)) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { literal: value };
  }
  throw new Error(`openapi.json has the enum value ${JSON.stringify(value)}, which no validator can hold.`);
}

function mergeProperties(left: Node, right: Node): Node {
  const merged = new Map(Object.entries(left));
  for (const [name, schema] of Object.entries(right)) {
    if (merged.has(name)) {
      merged.set(name, { allOf: [merged.get(name), schema] });
    } else {
      merged.set(name, schema);
    }
  }
  return Object.fromEntries(merged);
}

function merge(left: Node, right: Node): Node {
  const required = [...stringsAt(left["required"]), ...stringsAt(right["required"])];
  const merged = Object.fromEntries<unknown>([
    ...Object.entries(left),
    ...Object.entries(right),
    ["required", required],
  ]);
  if (!Object.hasOwn(right, "properties")) {
    return merged;
  }
  const properties = mergeProperties(objectAt(left["properties"]), objectAt(right["properties"]));
  return Object.fromEntries<unknown>([...Object.entries(merged), ["properties", properties]]);
}

function combine(parts: readonly Fields[]): Record<string, Field> {
  const names = [...new Set(parts.flatMap((part) => Object.keys(part)))];
  return Object.fromEntries(
    names.map((name) => {
      const present = parts.flatMap((part) => part[name] ?? []);
      const optional = present.length < parts.length || present.some((field) => field.optional);
      return [name, { optional, shape: union(present.map((field) => field.shape)) }];
    }),
  );
}

function operationArgs(
  id: string,
  found: readonly Argument[],
  fields: Fields,
  required: boolean,
): Record<string, Field> {
  const args = new Map(found.map(({ field, param }) => [param.name, field]));
  for (const [name, field] of Object.entries(fields)) {
    if (args.has(name)) {
      throw new Error(`${id} has a parameter and a body field both named ${name}.`);
    }
    args.set(name, { optional: field.optional || !required, shape: field.shape });
  }
  return Object.fromEntries(args);
}

function bodyNames(body: Shape | null, fields: Fields): string[] | null {
  if (isNull(body)) {
    return none;
  }
  return Object.keys(fields);
}

export {
  argumentName,
  bodyNames,
  combine,
  isLocation,
  isPublic,
  listAt,
  literal,
  members,
  merge,
  objectAt,
  operationArgs,
  stringsAt,
  union,
  without,
};
export type { Argument, Fields, Node };
