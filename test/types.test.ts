import { expectTypeOf, test } from "vitest";
import type { OperationName, OperationResult } from "../src/client/index.js";
import type * as operations from "../src/component/operations.js";

type IsAny<T> = 0 extends 1 & T ? true : false;

type Untyped = { [Name in OperationName]: IsAny<OperationResult<Name>> extends true ? Name : never }[OperationName];

test("every operation result has a type from openapi.json", () => {
  expectTypeOf<Untyped>().toEqualTypeOf<never>();
  expectTypeOf<OperationName>().toEqualTypeOf<keyof typeof operations>();
});

test("results carry the documented fields and types", () => {
  const user: OperationResult<"getUser"> = { id: "11348282", username: "NASA", name: "NASA", followers: 92_311_272 };
  expectTypeOf(user.name).toEqualTypeOf<string>();
  expectTypeOf<OperationResult<"getUser">["followers"]>().toEqualTypeOf<number | undefined>();
  expectTypeOf<OperationResult<"createDraft">["id"]>().toEqualTypeOf<string>();
  expectTypeOf<OperationResult<"listEvents">["events"][number]["occurredAt"]>().toEqualTypeOf<string>();
  expectTypeOf<OperationResult<"exportExtraction">>().toEqualTypeOf<ArrayBuffer>();
  expectTypeOf<OperationResult<"deleteDraft">>().toEqualTypeOf<null>();
  expectTypeOf<OperationResult<"streamEvents">[number]>().toHaveProperty("data");
});

test("a JSON-LD key keeps its value under a Convex name", () => {
  type Answer = Extract<OperationResult<"searchXquikDocumentation">, { results: unknown }>;
  expectTypeOf<Answer["results"][number]["context"]>().toEqualTypeOf<"https://schema.org">();
  expectTypeOf<Answer["results"][number]["type"]>().toEqualTypeOf<"TechArticle">();
});
