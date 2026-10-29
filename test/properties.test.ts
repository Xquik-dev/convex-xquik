import {
  array,
  asyncProperty,
  boolean,
  constantFrom,
  dictionary,
  double,
  assert as holds,
  integer,
  nat,
  oneof,
  option,
  record,
  string,
  stringMatching,
  tuple,
  uint8Array,
} from "fast-check";
import { componentTest, rejection, sign, stubFetch } from "./helpers.js";
import { describe, expect, it } from "vitest";
import type { Field, Shape } from "#src/component/shape.ts";
import { registry, schema } from "#src/component/request.ts";
import type { Arbitrary } from "fast-check";
import { check as checkSignature } from "#src/component/delivery.ts";
import { ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { none } from "#src/component/shape.ts";
import type { Value } from "convex/values";

type Compound = Exclude<Shape, string | { readonly ref: string } | { readonly literal: unknown }>;

const SEED = 20_261_029;
const NOW = Date.parse("2026-10-29T08:00:00.000Z");
const ONE = 1;
const FIVE_MINUTES_MS = 300_000;
const JUST_STALE_MS = FIVE_MINUTES_MS + ONE;
const FAR_FUTURE_MS = 1_000_000_000_000_000;
const BYTE_VALUES = 256;
const SMALL = 2;
const NONCE_BYTES = 16;
const REJECTED_BY_STUB = 418;
const SKIP = Symbol("skip");
const NO_SHAPE_ACCEPTS = 1n;
const OPERATIONS = Object.entries(registry.operations);
const RUNS_PER_OPERATION = 2;
const STUB_ERROR = { error: "stub", status: REJECTED_BY_STUB };
const FIXED_NONCE = "ab".repeat(NONCE_BYTES);
const encoder = new TextEncoder();

const secret = string({ minLength: 1, unit: "grapheme" });
const body = string({ unit: "grapheme" });
const nonce = stringMatching(/^[0-9a-f]{32}$/u);
const key = stringMatching(/^[a-z]{1,8}$/u);

const PRIMITIVES: Readonly<Record<Extract<Shape, string>, Arbitrary<Value>>> = {
  any: string(),
  boolean: boolean(),
  bytes: uint8Array({ maxLength: SMALL }).map((bytes) => Uint8Array.from(bytes).buffer),
  null: constantFrom(none),
  number: double({ noDefaultInfinity: true, noNaN: true }),
  string: string(),
};

function valueOf(shape: Shape): Arbitrary<Value> {
  if (typeof shape === "string") {
    return PRIMITIVES[shape];
  }
  if ("ref" in shape) {
    return valueOf(schema(shape.ref));
  }
  if ("literal" in shape) {
    return constantFrom(shape.literal);
  }
  return compoundOf(shape);
}

function compoundOf(shape: Compound): Arbitrary<Value> {
  if ("array" in shape) {
    return array(valueOf(shape.array), { maxLength: SMALL });
  }
  if ("record" in shape) {
    return dictionary(key, valueOf(shape.record), { maxKeys: SMALL });
  }
  if ("object" in shape) {
    return objectOf(shape.object);
  }
  return oneof(...shape.union.map((member) => valueOf(member)));
}

function fieldOf(field: Field): Arbitrary<Value | typeof SKIP> {
  if (field.optional) {
    return option(valueOf(field.shape), { nil: SKIP });
  }
  return valueOf(field.shape);
}

function objectOf(fields: Readonly<Record<string, Field>>): Arbitrary<Record<string, Value>> {
  const entries = Object.entries(fields).map(([name, field]) =>
    fieldOf(field).map((item): [string, Value | typeof SKIP] => [name, item]),
  );
  return tuple(...entries).map((pairs) =>
    Object.fromEntries(
      pairs.flatMap(([name, item]): [string, Value][] => {
        if (item === SKIP) {
          return [];
        }
        return [[name, item]];
      }),
    ),
  );
}

function withArgument(args: Readonly<Record<string, Value>>, name: string, value: Value): Record<string, Value> {
  return Object.fromEntries([...Object.entries(args), [name, value]]);
}

function acceptsAnything(shape: Shape): boolean {
  if (typeof shape === "string") {
    return shape === "any";
  }
  if ("ref" in shape) {
    return acceptsAnything(schema(shape.ref));
  }
  return "union" in shape && shape.union.some((member) => acceptsAnything(member));
}

function invalidArguments(
  args: Readonly<Record<string, Field>>,
  valid: Readonly<Record<string, Value>>,
): Record<string, Value>[] {
  const wrong = Object.entries(args)
    .filter(([, field]) => !acceptsAnything(field.shape))
    .map(([name]) => withArgument(valid, name, NO_SHAPE_ACCEPTS));
  return [withArgument(valid, "notAnArgument", ONE), ...wrong];
}

function isValidationError(error: unknown): boolean {
  return error instanceof Error && !(error instanceof ConvexError);
}

function changeByte(text: string, at: number, shift: number): ArrayBuffer {
  const bytes = encoder.encode(text);
  const index = at % bytes.length;
  return bytes.map((byte, position) => {
    if (position === index) {
      return (byte + shift) % BYTE_VALUES;
    }
    return byte;
  }).buffer;
}

function caller(): (id: string, args: Readonly<Record<string, Value>>) => Promise<unknown> {
  const backend = componentTest();
  return async (id, args) => {
    const reference = makeFunctionReference<"action", Record<string, Value>, Value>(`operations:${id}`);
    return await rejection(backend.action(reference, args));
  };
}

async function verdict(
  secretKey: string,
  text: string,
  sent: Readonly<ArrayBuffer>,
  timestamp: string,
): Promise<unknown> {
  const signed = await sign(text, { nonce: FIXED_NONCE, secret: secretKey, timestamp });
  return await checkSignature(secretKey, new Headers(signed.headers), sent, NOW);
}

describe("the webhook signature check", () => {
  it("accepts every body signed with the secret within 5 minutes of the clock", { timeout: 20_000 }, async () => {
    expect.hasAssertions();
    const skew = integer({ max: FIVE_MINUTES_MS, min: -FIVE_MINUTES_MS });
    await holds(
      asyncProperty(secret, body, nonce, skew, async (secretKey, text, id, offset) => {
        const signed = await sign(text, { nonce: id, secret: secretKey, timestamp: String(NOW + offset) });
        const headers = new Headers(signed.headers);
        await expect(checkSignature(secretKey, headers, encoder.encode(text).buffer, NOW)).resolves.toStrictEqual({
          nonce: id,
          ok: true,
        });
      }),
      {
        examples: [
          ["s", "", FIXED_NONCE, -FIVE_MINUTES_MS],
          ["s", "{}", FIXED_NONCE, FIVE_MINUTES_MS],
        ],
        seed: SEED,
      },
    );
  });

  it("rejects every body changed in any byte after signing", { timeout: 20_000 }, async () => {
    expect.hasAssertions();
    const change = record({ at: nat(), shift: integer({ max: BYTE_VALUES - ONE, min: ONE }) });
    const text = string({ minLength: 1, unit: "grapheme" });
    await holds(
      asyncProperty(secret, text, change, async (secretKey, sent, { at, shift }) => {
        const changed = changeByte(sent, at, shift);
        await expect(verdict(secretKey, sent, changed, String(NOW))).resolves.toStrictEqual({
          ok: false,
          reason: "bad signature",
        });
      }),
      { seed: SEED },
    );
  });
});

describe("the webhook timestamp check", () => {
  it(
    "rejects every signed body whose timestamp is more than 5 minutes from the clock",
    { timeout: 20_000 },
    async () => {
      expect.hasAssertions();
      const skew = oneof(
        integer({ max: FAR_FUTURE_MS, min: JUST_STALE_MS }),
        integer({ max: -JUST_STALE_MS, min: -NOW }),
      );
      await holds(
        asyncProperty(secret, body, skew, async (secretKey, text, offset) => {
          await expect(
            verdict(secretKey, text, encoder.encode(text).buffer, String(NOW + offset)),
          ).resolves.toStrictEqual({
            ok: false,
            reason: "stale timestamp",
          });
        }),
        {
          examples: [
            ["s", "{}", JUST_STALE_MS],
            ["s", "{}", -JUST_STALE_MS],
          ],
          seed: SEED,
        },
      );
    },
  );
});

describe("the operation argument validators", () => {
  it("pass generated valid arguments of every operation on to Xquik", { timeout: 60_000 }, async () => {
    expect.hasAssertions();
    const recorded = stubFetch(() => Response.json({ error: "stub" }, { status: REJECTED_BY_STUB }));
    await Promise.all(
      OPERATIONS.map(async ([id, { args }]) => {
        const call = caller();
        await holds(
          asyncProperty(objectOf(args), async (valid) => {
            await expect(call(id, valid)).resolves.toStrictEqual(STUB_ERROR);
          }),
          { numRuns: RUNS_PER_OPERATION, seed: SEED },
        );
      }),
    );
    expect(recorded).toHaveLength(OPERATIONS.length * RUNS_PER_OPERATION);
  });

  it("reject wrong or undeclared arguments of every operation before calling Xquik", { timeout: 60_000 }, async () => {
    expect.hasAssertions();
    const recorded = stubFetch(() => Response.json({ error: "stub" }, { status: REJECTED_BY_STUB }));
    await Promise.all(
      OPERATIONS.map(async ([id, { args }]) => {
        const call = caller();
        await holds(
          asyncProperty(objectOf(args), async (valid) => {
            const sent = invalidArguments(args, valid);
            const rejected = await Promise.all(sent.map(async (invalid) => await call(id, invalid)));
            expect(sent.filter((_invalid, index) => !isValidationError(rejected[index]))).toStrictEqual([]);
          }),
          { numRuns: ONE, seed: SEED },
        );
      }),
    );
    expect(recorded).toStrictEqual([]);
  });
});
