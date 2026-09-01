import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  blockerKind,
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

describe("worker blockers", () => {
  it("names the blocker the worker actually reported", () => {
    expect(blockerKind("Needs email OTP: workday emailed a code.")).toBe(
      "emailOtp"
    );
    expect(
      blockerKind("Needs posting unavailable: the URL returns a 404.")
    ).toBe("postingUnavailable");
    expect(
      blockerKind("  needs submission approval: staff engineer at acme.")
    ).toBe("submissionApproval");
  });

  it("reports no blocker for a failure that names none", () => {
    // The reported incident: an apply against a taken-down posting failed
    // with no blocker, and was narrated to the candidate as an OTP problem.
    expect(
      blockerKind("The application could not be completed.")
    ).toBeUndefined();
    expect(blockerKind("")).toBeUndefined();
    // Only the prefix counts. A message that merely mentions a code is not a
    // request for one.
    expect(
      blockerKind("The page mentioned a verification code somewhere.")
    ).toBeUndefined();
  });
});
