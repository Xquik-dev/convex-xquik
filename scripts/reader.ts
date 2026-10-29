import type { Argument, Fields, Node } from "./nodes.ts";
import {
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
} from "./nodes.ts";
import type { Field, Operation, Shape } from "#src/component/shape.ts";
import { isRecord } from "#src/component/shape.ts";

const SCHEMAS = "#/components/schemas/";
const NO_VARIANTS = 0;

const PRIMITIVE_TYPES = new Map<string, Shape>([
  ["boolean", "boolean"],
  ["integer", "number"],
  ["null", "null"],
  ["number", "number"],
  ["string", "string"],
]);

const EVENTS: Shape = {
  array: {
    object: {
      data: { optional: false, shape: "any" },
      event: { optional: true, shape: "string" },
      id: { optional: true, shape: "string" },
    },
  },
};

class Reader {
  private readonly building: string[] = [];
  private readonly root: Node;
  private readonly schemas = new Map<string, Shape>();

  public constructor(root: Node) {
    this.root = root;
  }

  public named(): [string, Shape][] {
    return [...this.schemas];
  }

  public entry(path: string, method: string, item: Node): [string, Operation][] {
    const op = objectAt(item[method]);
    const id = op["operationId"];
    if (typeof id !== "string" || !isPublic(op["security"] ?? this.root["security"])) {
      return [];
    }
    const found = [...listAt(item["parameters"]), ...listAt(op["parameters"])].flatMap((raw) => this.argument(raw));
    const { args, body } = this.request(id, op, found);
    const { response, result } = this.outcome(op);
    const params = found.map(({ param }) => param);
    return [[id, { args, body, method: method.toUpperCase(), params, path, response, result }]];
  }

  private argument(raw: unknown): Argument[] {
    const param = this.resolve(raw);
    const wire = param["name"];
    const location = param["in"];
    if (typeof wire !== "string" || !isLocation(location)) {
      return [];
    }
    const name = argumentName(location, wire);
    const field = { optional: param["required"] !== true, shape: this.shape(param["schema"]) };
    return [{ field, param: { in: location, name, wire } }];
  }

  private request(id: string, op: Node, found: readonly Argument[]): Pick<Operation, "args" | "body"> {
    const requestBody = this.resolve(op["requestBody"]);
    const body = this.bodyShape(requestBody);
    const fields = combine(this.objects(id, members(body ?? { object: {} })));
    return { args: operationArgs(id, found, fields, requestBody["required"] === true), body: bodyNames(body, fields) };
  }

  private bodyShape(requestBody: Node): Shape | null {
    const media = objectAt(objectAt(requestBody["content"])["application/json"]);
    if (!Object.hasOwn(media, "schema")) {
      return null;
    }
    return this.deref(this.shape(media["schema"]));
  }

  private outcome(op: Node): Pick<Operation, "response" | "result"> {
    const responses = objectAt(op["responses"]);
    const contents = Object.keys(responses)
      .filter((code) => code.startsWith("2"))
      .map((code) => objectAt(this.resolve(responses[code])["content"]));
    const types = new Set(contents.flatMap((content) => Object.keys(content)));
    if (types.has("application/json")) {
      return { response: "json", result: this.jsonResult(contents) };
    }
    if (types.has("application/octet-stream")) {
      return { response: "bytes", result: "bytes" };
    }
    if (types.has("text/event-stream")) {
      return { response: "events", result: EVENTS };
    }
    return { response: "none", result: "null" };
  }

  private jsonResult(contents: readonly Node[]): Shape {
    const results = contents.map((content) => {
      if (Object.hasOwn(content, "application/json")) {
        return this.shape(objectAt(content["application/json"])["schema"]);
      }
      return "null";
    });
    return union(results);
  }

  private pointer(ref: string): Node {
    let target: unknown = this.root;
    for (const token of ref.slice("#/".length).split("/")) {
      const parent = objectAt(target);
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!Object.hasOwn(parent, key)) {
        throw new Error(`openapi.json has the broken reference ${ref}.`);
      }
      target = parent[key];
    }
    return objectAt(target);
  }

  private resolve(value: unknown, seen: readonly string[] = []): Node {
    const node = objectAt(value);
    const ref = node["$ref"];
    if (typeof ref !== "string") {
      return node;
    }
    if (seen.includes(ref)) {
      throw new Error(`openapi.json has the reference cycle ${[...seen, ref].join(" > ")}.`);
    }
    return this.resolve(this.pointer(ref), [...seen, ref]);
  }

  private expand(value: unknown): Node {
    return this.flatten(this.resolve(value));
  }

  private build(name: string): Shape {
    return this.schemas.get(name) ?? this.fresh(name);
  }

  private fresh(name: string): Shape {
    const ref = SCHEMAS + name;
    if (this.building.includes(ref)) {
      throw new Error(`openapi.json has the reference cycle ${[...this.building, ref].join(" > ")}.`);
    }
    this.building.push(ref);
    const built = this.shape(this.pointer(ref));
    this.building.pop();
    this.schemas.set(name, built);
    return built;
  }

  private deref(value: Shape): Shape {
    if (typeof value === "object" && "ref" in value) {
      return this.deref(this.build(value.ref));
    }
    return value;
  }

  private flatten(raw: Node): Node {
    let flat = without(raw, ["allOf"]);
    for (const part of listAt(raw["allOf"])) {
      flat = merge(flat, this.expand(part));
    }
    return flat;
  }

  private fields(node: Node): Record<string, Field> {
    const required = stringsAt(node["required"]);
    return Object.fromEntries(
      Object.entries(objectAt(node["properties"])).map(([wire, value]) => {
        const optional = !required.includes(wire);
        const shape = this.shape(value);
        const name = wire.replace(/^@/u, "");
        if (name === wire) {
          return [name, { optional, shape }];
        }
        return [name, { optional, shape, wire }];
      }),
    );
  }

  private objects(id: string, shapes: readonly Shape[]): Fields[] {
    return shapes.map((member) => {
      const shape = this.deref(member);
      if (typeof shape === "object" && "object" in shape) {
        return shape.object;
      }
      throw new Error(`${id} has ${JSON.stringify(shape)} where it needs an object.`);
    });
  }

  private typeShape(node: Node, type: string): Shape {
    if (type === "array") {
      return { array: this.shape(node["items"]) };
    }
    return PRIMITIVE_TYPES.get(type) ?? this.objectShape(node);
  }

  private typesShape(node: Node): Shape {
    if (!Object.hasOwn(node, "type")) {
      return this.objectShape(node);
    }
    const types = [node["type"]].flat().filter((type) => typeof type === "string");
    return union(types.map((type) => this.typeShape(node, type)));
  }

  private objectShape(node: Node): Shape {
    if (Object.hasOwn(node, "properties")) {
      return { object: this.fields(node) };
    }
    const extra = node["additionalProperties"];
    if (isRecord(extra)) {
      return { record: this.shape(extra) };
    }
    return "any";
  }

  private variantShape(node: Node, variants: readonly unknown[]): Shape {
    if (Object.hasOwn(node, "properties") || Object.hasOwn(node, "required")) {
      return union(variants.map((variant) => this.nodeShape(merge(node, this.expand(variant)))));
    }
    return union(variants.map((variant) => this.shape(variant)));
  }

  private nodeShape(raw: Node): Shape {
    const flat = this.flatten(raw);
    const node = without(flat, ["anyOf", "oneOf"]);
    const variants = [...listAt(flat["oneOf"]), ...listAt(flat["anyOf"])];
    if (Object.hasOwn(node, "const")) {
      return literal(node["const"]);
    }
    if (Object.hasOwn(node, "enum")) {
      return union(listAt(node["enum"]).map((value) => literal(value)));
    }
    if (variants.length > NO_VARIANTS) {
      return this.variantShape(node, variants);
    }
    return this.typesShape(node);
  }

  private shape(value: unknown): Shape {
    const node = objectAt(value);
    const ref = node["$ref"];
    if (typeof ref !== "string" || !ref.startsWith(SCHEMAS)) {
      return this.nodeShape(this.resolve(node));
    }
    const name = ref.slice(SCHEMAS.length);
    this.build(name);
    return { ref: name };
  }
}

export default Reader;
