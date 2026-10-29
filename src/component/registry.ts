import { ConvexError, v } from "convex/values";
import type { Field, Operation, Shape } from "./shape.js";
import { isList, isNull, isRecord, parseRegistry } from "./shape.js";
import { json, toValue } from "./values.js";
import type { OptionalProperty, Validator, Value } from "convex/values";
import data from "./registry.json" with { type: "json" };

type Primitive = Extract<Shape, string>;
type Compound = Exclude<Shape, Primitive | { readonly literal: unknown } | { readonly ref: unknown }>;
type Fields = Record<string, Validator<Value | undefined, OptionalProperty, string>>;

const registry = parseRegistry(data);

const PRIMITIVES: Record<Primitive, Validator<Value, "required", string>> = {
  any: json,
  boolean: v.boolean(),
  bytes: v.bytes(),
  null: v.null(),
  number: v.number(),
  string: v.string(),
};

const CHECKS: Readonly<Record<Primitive, (value: unknown) => boolean>> = {
  any: () => true,
  boolean: (value) => typeof value === "boolean",
  bytes: (value) => value instanceof ArrayBuffer,
  null: isNull,
  number: (value) => typeof value === "number",
  string: (value) => typeof value === "string",
};

const named = new Map<string, Validator<Value, "required", string>>();

function missing(message: string): never {
  throw new Error(message);
}

function schema(name: string): Shape {
  return registry.schemas[name] ?? missing(`The operation registry has no schema ${name}. Run npm run generate.`);
}

function remember(name: string): Validator<Value, "required", string> {
  const built = validator(schema(name));
  named.set(name, built);
  return built;
}

function validator(shape: Shape): Validator<Value, "required", string> {
  if (typeof shape === "string") {
    return PRIMITIVES[shape];
  }
  if ("ref" in shape) {
    return named.get(shape.ref) ?? remember(shape.ref);
  }
  if ("literal" in shape) {
    return v.literal(shape.literal);
  }
  return compoundValidator(shape);
}

function compoundValidator(shape: Compound): Validator<Value, "required", string> {
  if ("array" in shape) {
    return v.array(validator(shape.array));
  }
  if ("record" in shape) {
    return v.record(v.string(), validator(shape.record));
  }
  if ("object" in shape) {
    return v.object(fields(shape.object));
  }
  return v.union(...shape.union.map(validator));
}

function matches(shape: Shape, value: unknown): boolean {
  if (typeof shape === "string") {
    return CHECKS[shape](value);
  }
  if ("ref" in shape) {
    return matches(schema(shape.ref), value);
  }
  if ("literal" in shape) {
    return value === shape.literal;
  }
  return compoundMatches(shape, value);
}

function compoundMatches(shape: Compound, value: unknown): boolean {
  if ("array" in shape) {
    return isList(value) && value.every((item) => matches(shape.array, item));
  }
  if ("record" in shape) {
    return isRecord(value) && Object.values(value).every((item) => matches(shape.record, item));
  }
  if ("object" in shape) {
    return (
      isRecord(value) &&
      Object.entries(shape.object).every(([name, field]) => {
        if (name in value) {
          return matches(field.shape, value[name]);
        }
        return field.optional;
      })
    );
  }
  return shape.union.some((member) => matches(member, value));
}

function project(shape: Shape, value: unknown): Value {
  if (typeof shape === "string" || "literal" in shape) {
    return toValue(value);
  }
  if ("ref" in shape) {
    return project(schema(shape.ref), value);
  }
  return projectCompound(shape, value);
}

function projectCompound(shape: Compound, value: unknown): Value {
  if ("union" in shape) {
    return projectUnion(shape.union, value);
  }
  if ("array" in shape && isList(value)) {
    return value.map((item) => project(shape.array, item));
  }
  if ("record" in shape && isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(shape.record, item)]));
  }
  if ("object" in shape && isRecord(value)) {
    return Object.fromEntries(
      Object.entries(shape.object).flatMap(([name, field]): [string, Value][] => {
        const key = field.wire ?? name;
        if (key in value) {
          return [[name, project(field.shape, value[key])]];
        }
        return [];
      }),
    );
  }
  return toValue(value);
}

function projectUnion(members: readonly Shape[], value: unknown): Value {
  const fits = members.flatMap((member): Value[] => {
    const item = project(member, value);
    if (matches(member, item)) {
      return [item];
    }
    return [];
  });
  let best = fits[0] ?? toValue(value);
  for (const item of fits) {
    if (JSON.stringify(item).length > JSON.stringify(best).length) {
      best = item;
    }
  }
  return best;
}

function fieldValidator(field: Field): Validator<Value | undefined, OptionalProperty, string> {
  if (field.optional) {
    return v.optional(validator(field.shape));
  }
  return validator(field.shape);
}

function fields(shape: Readonly<Record<string, Field>>): Fields {
  return Object.fromEntries(Object.entries(shape).map(([name, field]) => [name, fieldValidator(field)]));
}

function unknownOperation(id: string): never {
  throw new ConvexError({ error: "unknown_operation", message: `${id} is not an Xquik operation.`, status: 404 });
}

function find(id: string): Operation {
  return registry.operations[id] ?? unknownOperation(id);
}

function argument(operation: Operation, name: string): Validator<Value | undefined, OptionalProperty, string> {
  const field = operation.args[name] ?? missing(`${operation.method} ${operation.path} has no argument ${name}.`);
  return fieldValidator(field);
}

export { argument, fields, find, matches, project, registry, schema, validator };
export type { Fields };
