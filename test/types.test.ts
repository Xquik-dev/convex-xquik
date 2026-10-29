import { describe, expect, expectTypeOf, it } from "vitest";
import { find, matches, project, registry } from "#src/component/request.ts";
import type { OperationName, OperationResult } from "#src/client.ts";

describe("operation result types", () => {
  it("every operation result has a type from openapi.json", { timeout: 5000 }, async () => {
    expect.hasAssertions();
    const operations = await import("#src/component/operations.ts");
    expectTypeOf<OperationResult<OperationName>>().not.toBeAny();
    expectTypeOf<OperationName>().toEqualTypeOf<keyof typeof operations>();
    const exported = Object.keys(operations).toSorted();
    expect(exported).toStrictEqual(Object.keys(registry.operations).toSorted());
  });

  it("results carry the documented fields and types", { timeout: 5000 }, () => {
    expect.hasAssertions();
    const user: OperationResult<"getUser"> = { followers: 92_311_272, id: "11348282", name: "NASA", username: "NASA" };
    expectTypeOf(user.name).toEqualTypeOf<string>();
    expectTypeOf<OperationResult<"getUser">["followers"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<OperationResult<"createDraft">["id"]>().toEqualTypeOf<string>();
    expectTypeOf<OperationResult<"listEvents">["events"][number]["occurredAt"]>().toEqualTypeOf<string>();
    expectTypeOf<OperationResult<"exportExtraction">>().toEqualTypeOf<ArrayBuffer>();
    expectTypeOf<OperationResult<"deleteDraft">>().toEqualTypeOf<null>();
    expectTypeOf<OperationResult<"streamEvents">[number]>().toHaveProperty("data");
    expect(matches(find("getUser").result, user)).toBe(true);
  });

  it("a JSON-LD key keeps its value under a Convex name", { timeout: 5000 }, () => {
    expect.hasAssertions();
    type Answer = Extract<OperationResult<"searchXquikDocumentation">, { results: unknown }>;
    expectTypeOf<Answer["results"][number]["context"]>().toEqualTypeOf<"https://schema.org">();
    expectTypeOf<Answer["results"][number]["type"]>().toEqualTypeOf<"TechArticle">();
    const answer = project(
      { ref: "NlwebDocumentationResult" },
      { "@context": "https://schema.org", "@type": "TechArticle" },
    );
    expect(answer).toStrictEqual({ context: "https://schema.org", type: "TechArticle" });
  });
});
