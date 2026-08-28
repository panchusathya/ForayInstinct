import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseTaskCompletion,
  taskCompletionSchema,
} from "../lib/task-completion";

describe("task completion schema", () => {
  it("does not emit a JSON Schema that rejects extra keys or non-enum statuses", () => {
    const jsonSchema = z.toJSONSchema(taskCompletionSchema);
    const status = jsonSchema.properties?.status;

    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.required).toEqual(["message", "status"]);
    expect(jsonSchema.additionalProperties).not.toBe(false);
    expect(status).toEqual({ minLength: 1, type: "string" });
  });

  it("accepts the statuses and extra keys workers actually emit", () => {
    expect(
      parseTaskCompletion({
        liveViewUrl: "https://example.test/view",
        message: "Ashby is still on the work-authorization step.",
        status: "failed",
      })
    ).toEqual({
      message: "Ashby is still on the work-authorization step.",
      status: "failure",
    });
    expect(
      parseTaskCompletion(
        JSON.stringify({
          message: "Submitted. Confirmation #A1.",
          status: "success",
        })
      )
    ).toEqual({
      message: "Submitted. Confirmation #A1.",
      status: "success",
    });
  });

  it("rejects an empty result instead of inventing success", () => {
    expect(
      parseTaskCompletion({ message: "   ", status: "success" })
    ).toBeUndefined();
    expect(parseTaskCompletion("not json")).toBeUndefined();
  });
});
