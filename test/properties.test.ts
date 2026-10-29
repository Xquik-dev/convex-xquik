import {
  array,
  asyncProperty,
  boolean,
  constantFrom,
  dictionary,
  double,
  assert as holds,
  integer,
  jsonValue,
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
import { isList, isRecord } from "#src/component/shape.ts";
import { matches, registry, schema } from "#src/component/request.ts";
import type { Arbitrary } from "fast-check";
import { check as checkSignature } from "#src/component/delivery.ts";
import { ConvexError } from "convex/values";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";

type Compound = Exclude<Shape, string | { readonly ref: string } | { readonly literal: unknown }>;

const SEED = 20_261_029;
const NOW = Date.parse("2026-10-29T08:00:00.000Z");
const FIRST = 0;
const ONE = 1;
const FIVE_MINUTES_MS = 300_000;
const JUST_STALE_MS = FIVE_MINUTES_MS + ONE;
const FAR_FUTURE_MS = 1_000_000_000_000_000;
const BYTE_VALUES = 256;
const SMALL = 2;
const NONCE_BYTES = 16;
const REJECTED_BY_STUB = 418;
const SKIP = Symbol("skip");
const WRONG_VALUES: readonly Value[] = [true, ONE, "x", []];
const STUB_ERROR = { error: "stub", status: REJECTED_BY_STUB };
const FIXED_NONCE = "ab".repeat(NONCE_BYTES);
const encoder = new TextEncoder();

const secret = string({ minLength: 1, unit: "grapheme" });
const body = string({ unit: "grapheme" });
const nonce = stringMatching(/^[0-9a-f]{32}$/u);
const nothing = jsonValue().filter((item) => typeof item === "object" && !isRecord(item) && !isList(item));
const key = stringMatching(/^[a-z]{1,8}$/u);

const PRIMITIVES: Readonly<Record<Extract<Shape, string>, Arbitrary<Value>>> = {
  any: string(),
  boolean: boolean(),
  bytes: uint8Array({ maxLength: SMALL }).map((bytes) => Uint8Array.from(bytes).buffer),
  null: nothing,
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

function wrongArguments(
  args: Readonly<Record<string, Field>>,
  valid: Readonly<Record<string, Value>>,
): Record<string, Value>[] {
  return Object.entries(args).flatMap(([name, field]) =>
    WRONG_VALUES.filter((candidate) => !field.optional && !matches(field.shape, candidate))
      .slice(FIRST, ONE)
      .map((value) => withArgument(valid, name, value)),
  );
}

const operation = constantFrom(...Object.entries(registry.operations)).chain(([id, { args }]) =>
  objectOf(args).map((valid) => ({ args, id, valid })),
);

const invalid = operation.chain(({ args, id, valid }) =>
  constantFrom(withArgument(valid, "notAnArgument", ONE), ...wrongArguments(args, valid)).map((sent) => ({
    id,
    sent,
  })),
);

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

async function call(id: string, args: Readonly<Record<string, Value>>): Promise<unknown> {
  const reference = makeFunctionReference<"action", Record<string, Value>, Value>(`operations:${id}`);
  return await rejection(componentTest().action(reference, args));
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
  it("pass every generated set of valid arguments on to Xquik", { timeout: 60_000 }, async () => {
    expect.hasAssertions();
    const recorded = stubFetch(() => Response.json({ error: "stub" }, { status: REJECTED_BY_STUB }));
    await holds(
      asyncProperty(operation, async ({ id, valid }) => {
        const before = recorded.length;
        await expect(call(id, valid)).resolves.toStrictEqual(STUB_ERROR);
        expect(recorded).toHaveLength(before + ONE);
      }),
      { seed: SEED },
    );
  });

  it("reject a wrong type or an undeclared argument before calling Xquik", { timeout: 60_000 }, async () => {
    expect.hasAssertions();
    const recorded = stubFetch(() => Response.json({ error: "stub" }, { status: REJECTED_BY_STUB }));
    await holds(
      asyncProperty(invalid, async ({ id, sent }) => {
        const rejected = await call(id, sent);
        expect(rejected).toBeInstanceOf(Error);
        expect(rejected).not.toBeInstanceOf(ConvexError);
      }),
      { seed: SEED },
    );
    expect(recorded).toStrictEqual([]);
  });
});
