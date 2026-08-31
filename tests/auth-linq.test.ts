import { getToken } from "@vercel/connect";
import { APIError } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { phoneOtpErrorMessage } from "../app/sign-in/phone-auth-form";

vi.mock("@vercel/connect", () => ({ getToken: vi.fn<typeof getToken>() }));

const linqApiErrorSchema = z.object({
  code: z.string(),
  linqError: z.object({
    code: z.number(),
    message: z.string(),
    status: z.number(),
    trace_id: z.string(),
  }),
  message: z.string(),
});

describe("Linq phone authentication", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-ai-gateway-key");
    vi.stubEnv(
      "BETTER_AUTH_SECRET",
      "0123456789abcdefghijklmnopqrstuvwxyzABCD"
    );
    vi.stubEnv("BETTER_AUTH_URL", "https://example.com");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://user:password@example.com/database"
    );
    vi.stubEnv("KERNEL_API_KEY", "test-kernel-key");
    vi.stubEnv(
      "SECRET_ENCRYPTION_KEY",
      "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("preserves provider diagnostics and returns actionable client copy", async () => {
    vi.stubEnv("LINQ_CONNECTOR", "linq/open-instinct");
    vi.stubEnv("LINQ_PHONE_NUMBER", "+12025550123");
    vi.mocked(getToken).mockResolvedValue("test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            code: 2015,
            message: "no eligible sending line available",
            trace_id: "trace-123",
          },
          { status: 409 }
        )
      )
    );

    const { sendPhoneCode } = await import("../auth");
    const error: unknown = await sendPhoneCode({
      code: "123456",
      to: "+12025550123",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(APIError);
    if (!(error instanceof APIError)) throw new TypeError("Expected APIError");

    const body = linqApiErrorSchema.parse(error.body);
    expect(body).toMatchObject({
      code: "LINQ_CONTACT_NOT_ALLOWED",
      linqError: {
        code: 2015,
        message: "no eligible sending line available",
        status: 409,
        trace_id: "trace-123",
      },
    });
    expect(phoneOtpErrorMessage(body)).toContain("Messaging Contacts");
  });

  it("uses the direct Linq API key for sign-in codes when it is configured", async () => {
    vi.stubEnv("LINQ_API_KEY", "direct-linq-api-key");
    vi.stubEnv("LINQ_WEBHOOK_SECRET", "direct-linq-webhook-secret");
    vi.stubEnv("LINQ_PHONE_NUMBER", "+12025550123");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const { sendPhoneCode } = await import("../auth");
    await expect(
      sendPhoneCode({ code: "123456", to: "+12025550123" })
    ).resolves.toBeUndefined();

    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.linqapp.com/api/partner/v3/messages",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer direct-linq-api-key",
        }),
      })
    );
  });
});
