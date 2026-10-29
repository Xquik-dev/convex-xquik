import { describe, expect, it } from "vitest";

const REGISTERED = 209;
const MISSING_ARGS = '{"type":"any"}';
const MISSING_RETURNS = "null";
const FUNCTION_FLAGS = ["isQuery", "isMutation", "isAction"];

const modules = import.meta.glob<Readonly<Record<string, unknown>>>("#src/component/**/*.ts");

interface Contract {
  readonly name: string;
  readonly args: string;
  readonly returns: string;
}

function isExport(value: unknown): value is () => string {
  return typeof value === "function";
}

function isRegistered(value: unknown): boolean {
  return FUNCTION_FLAGS.some((flag) => Reflect.get(new Object(value), flag) === true);
}

function exported(value: unknown, key: string, missing: string): string {
  const read: unknown = Reflect.get(new Object(value), key);
  if (isExport(read)) {
    return read();
  }
  return missing;
}

function contractOf(name: string, value: unknown): Contract {
  return {
    args: exported(value, "exportArgs", MISSING_ARGS),
    name,
    returns: exported(value, "exportReturns", MISSING_RETURNS),
  };
}

function isUnvalidated({ args, returns }: Contract): boolean {
  return args === MISSING_ARGS || returns === MISSING_RETURNS;
}

async function contracts(): Promise<Contract[]> {
  const loaded = await Promise.all(
    Object.entries(modules).map(async ([path, load]) => ({ exports: await load(), path })),
  );
  return loaded.flatMap(({ exports, path }) =>
    Object.entries(exports)
      .filter(([, value]) => isRegistered(value))
      .map(([name, value]) => contractOf(`${path.replace(/^.*\/component\//u, "")} ${name}`, value)),
  );
}

describe("the component's registered functions", () => {
  it("each declare an args validator and a returns validator", { timeout: 10_000 }, async () => {
    expect.hasAssertions();
    const found = await contracts();
    const unvalidated = found.filter((contract) => isUnvalidated(contract));
    expect(found).toHaveLength(REGISTERED);
    expect(unvalidated.map(({ name }) => name)).toStrictEqual([]);
  });
});
