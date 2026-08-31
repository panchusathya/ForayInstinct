import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCalendarEvent,
  searchGoogleContacts,
} from "@/agent/lib/google-workspace/calendar";
import {
  isMissingGoogleGrant,
  withGoogleAuth,
} from "@/agent/lib/google-workspace/client";
import { buildEmailOtpSearchQuery } from "@/agent/lib/google-workspace/email-otp";
import {
  readGmailThread,
  searchGmail,
  sendGmail,
  waitForEmailOtp,
} from "@/agent/lib/google-workspace/gmail";

interface RequestOptions {
  signal: AbortSignal;
}

const google = vi.hoisted(() => ({
  calendar: vi.fn<(options: unknown) => unknown>(),
  gmail: vi.fn<(options: unknown) => unknown>(),
  people: vi.fn<(options: unknown) => unknown>(),
  setCredentials: vi.fn<(credentials: { access_token: string }) => void>(),
}));

vi.mock("@googleapis/calendar", () => ({ calendar: google.calendar }));
vi.mock("@googleapis/gmail", () => ({
  auth: {
    OAuth2: class {
      setCredentials = google.setCredentials;
    },
  },
  gmail: google.gmail,
}));
vi.mock("@googleapis/people", () => ({ people: google.people }));

afterEach(() => vi.clearAllMocks());

describe("generated Google Workspace clients", () => {
  it("hands the Connect token to Google and requests reauthorization on 401", async () => {
    const ctx = toolContext();
    const error = new GoogleApiError(401);

    await expect(withGoogleAuth(ctx, () => Promise.reject(error))).rejects.toBe(
      error
    );

    expect(ctx.getToken).toHaveBeenCalledOnce();
    expect(google.setCredentials).toHaveBeenCalledWith({
      access_token: "google-access-token",
    });
    expect(ctx.requireAuth).toHaveBeenCalledOnce();
  });

  it("sends typed Gmail requests with a stable retry-safe message ID", async () => {
    const ctx = toolContext();
    const send = vi
      .fn<
        (
          request: unknown,
          options: RequestOptions
        ) => Promise<{ data: { id: string; threadId: string } }>
      >()
      .mockResolvedValue({
        data: { id: "sent-1", threadId: "thread-1" },
      });
    googleClients({ gmail: { users: { messages: { send } } } });

    await sendGmail(ctx, {
      bcc: [],
      body: "Hello",
      cc: [],
      subject: "Status",
      to: ["person@example.com"],
    });

    const stableId = createHash("sha256")
      .update("session-1:call-1")
      .digest("hex")
      .slice(0, 48);
    const raw = Buffer.from(
      [
        "To: person@example.com",
        "Subject: Status",
        `Message-ID: <openinstinct-${stableId}@local>`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
      ].join("\r\n") + "\r\n\r\nHello",
      "utf8"
    ).toString("base64url");
    expect(send).toHaveBeenCalledWith(
      { requestBody: { raw }, userId: "me" },
      { signal: ctx.abortSignal }
    );
  });

  it("redacts six-digit codes in ordinary Gmail search and thread reads", async () => {
    const ctx = toolContext();
    const list = vi
      .fn<
        (
          request: unknown,
          options: RequestOptions
        ) => Promise<{ data: { messages?: { id: string }[] } }>
      >()
      .mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    const get = vi
      .fn<
        (
          request: unknown,
          options: RequestOptions
        ) => Promise<{ data: Record<string, unknown> }>
      >()
      .mockResolvedValue({
        data: {
          id: "m1",
          payload: {
            headers: [
              { name: "From", value: "Workday <noreply@myworkday.com>" },
              { name: "Subject", value: "Verification" },
            ],
          },
          snippet: "Your code is 123456",
        },
      });
    const threadGet = vi
      .fn<
        (
          request: unknown,
          options: RequestOptions
        ) => Promise<{ data: { id: string; messages: unknown[] } }>
      >()
      .mockResolvedValue({
        data: {
          id: "t1",
          messages: [
            {
              id: "m1",
              payload: {
                body: {
                  data: Buffer.from("Your code is 123456", "utf8").toString(
                    "base64url"
                  ),
                },
                headers: [
                  { name: "From", value: "Workday <noreply@myworkday.com>" },
                  { name: "Subject", value: "Verification" },
                ],
                mimeType: "text/plain",
              },
              snippet: "Your code is 123456",
            },
          ],
        },
      });
    googleClients({
      gmail: {
        users: { messages: { get, list }, threads: { get: threadGet } },
      },
    });

    await expect(searchGmail(ctx, "newer_than:1d", 10)).resolves.toEqual([
      expect.objectContaining({
        snippet: "Your code is [six-digit code redacted]",
      }),
    ]);
    await expect(readGmailThread(ctx, "t1")).resolves.toEqual({
      id: "t1",
      messages: [
        expect.objectContaining({
          body: "Your code is [six-digit code redacted]",
        }),
      ],
    });
  });

  it("returns an unredacted structured email OTP without the message body", async () => {
    const ctx = toolContext();
    const list = vi
      .fn<
        (
          request: unknown,
          options: RequestOptions
        ) => Promise<{ data: { messages?: { id: string }[] } }>
      >()
      .mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    const get = vi
      .fn<
        (
          request: unknown,
          options: RequestOptions
        ) => Promise<{ data: Record<string, unknown> }>
      >()
      .mockResolvedValue({
        data: gmailOtpMessage("Your verification code is 123456"),
      });
    googleClients({ gmail: { users: { messages: { get, list } } } });

    await expect(
      waitForEmailOtp(
        ctx,
        { fromHint: "noreply@myworkday.com" },
        { timeoutMs: 0 }
      )
    ).resolves.toEqual({
      code: "123456",
      from: "Workday <noreply@myworkday.com>",
      receivedAt: "Fri, 29 Aug 2026 06:00:00 +0000",
      status: "found",
      subject: "Your verification code",
    });
    expect(list).toHaveBeenCalledWith(
      {
        maxResults: 5,
        q: buildEmailOtpSearchQuery({ fromHint: "noreply@myworkday.com" }),
        userId: "me",
      },
      { signal: ctx.abortSignal }
    );
    expect(ctx.requireAuth).not.toHaveBeenCalled();
  });

  it("polls until a verification email arrives", async () => {
    const ctx = toolContext();
    const list = vi
      .fn<
        (
          request: unknown,
          options: RequestOptions
        ) => Promise<{ data: { messages?: { id: string }[] } }>
      >()
      .mockResolvedValueOnce({ data: { messages: [] } })
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } });
    const get = vi
      .fn<
        (
          request: unknown,
          options: RequestOptions
        ) => Promise<{ data: Record<string, unknown> }>
      >()
      .mockResolvedValue({
        data: gmailOtpMessage("Your verification code is 123456"),
      });
    const sleep = vi.fn<(ms: number, signal: AbortSignal) => Promise<void>>();
    googleClients({ gmail: { users: { messages: { get, list } } } });

    await expect(
      waitForEmailOtp(
        ctx,
        {},
        { pollIntervalMs: 1_000, sleep, timeoutMs: 10_000 }
      )
    ).resolves.toMatchObject({ code: "123456", status: "found" });
    expect(sleep).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("times out when no verification email arrives", async () => {
    const ctx = toolContext();
    const list = vi
      .fn<
        (
          request: unknown,
          options: RequestOptions
        ) => Promise<{ data: { messages?: { id: string }[] } }>
      >()
      .mockResolvedValue({ data: { messages: [] } });
    googleClients({ gmail: { users: { messages: { list } } } });

    await expect(
      waitForEmailOtp(ctx, {}, { timeoutMs: 0 })
    ).resolves.toMatchObject({ status: "timeout" });
  });

  it("does not start Gmail consent when the mailbox is disconnected", async () => {
    const ctx = toolContext();
    ctx.getToken.mockRejectedValue(
      Object.assign(new Error("No Google grant for this user."), {
        name: "ConnectionAuthorizationRequiredError",
      })
    );

    await expect(waitForEmailOtp(ctx, {})).resolves.toMatchObject({
      status: "disconnected",
    });
    expect(ctx.requireAuth).not.toHaveBeenCalled();
  });

  it("never starts Google consent from a Gmail read", async () => {
    const ctx = toolContext();
    const error = Object.assign(new Error("No Google grant for this user."), {
      name: "ConnectionAuthorizationRequiredError",
    });
    ctx.getToken.mockRejectedValue(error);

    // A Gmail read only ever supports a larger task, so it must surface the
    // missing grant to its caller instead of making Eve emit an authorization
    // prompt that reaches iMessage as an unusable pairing code.
    await expect(searchGmail(ctx, "newer_than:1d", 5)).rejects.toBe(error);
    await expect(readGmailThread(ctx, "thread-1")).rejects.toBe(error);
    expect(ctx.requireAuth).not.toHaveBeenCalled();
    expect(isMissingGoogleGrant(error)).toBe(true);
  });

  it("recognizes a renamed Connect authorization error as a missing grant", () => {
    // Matching one exact list of class names would let a rename upstream turn
    // every graceful fallback back into a pairing-code prompt.
    for (const name of [
      "NoValidTokenError",
      "UserAuthorizationRequiredError",
      "ConnectionAuthorizationRequiredError",
      "AuthorizationRequiredError",
      "NoGrantError",
    ]) {
      expect(
        isMissingGoogleGrant(Object.assign(new Error("nope"), { name }))
      ).toBe(true);
    }
    expect(isMissingGoogleGrant(new Error("Gmail is down."))).toBe(false);
    expect(isMissingGoogleGrant(new GoogleApiError(401))).toBe(true);
    expect(isMissingGoogleGrant(new GoogleApiError(500))).toBe(false);
  });

  it("recovers a duplicate Calendar insert using the stable event ID", async () => {
    const ctx = toolContext();
    const insert = vi
      .fn<(request: unknown, options: RequestOptions) => Promise<never>>()
      .mockRejectedValue(new GoogleApiError(409));
    const get = vi
      .fn<
        (
          request: { calendarId: string; eventId: string },
          options: RequestOptions
        ) => Promise<{ data: { id: string; summary: string } }>
      >()
      .mockResolvedValue({
        data: { id: "existing-event", summary: "Planning" },
      });
    googleClients({ calendar: { events: { get, insert } } });

    await expect(
      createCalendarEvent(ctx, {
        attendees: ["person@example.com"],
        calendarId: "primary",
        end: "2026-08-28T11:00:00-04:00",
        start: "2026-08-28T10:00:00-04:00",
        summary: "Planning",
        timezone: "America/New_York",
      })
    ).resolves.toEqual({ id: "existing-event", summary: "Planning" });

    const eventId = createHash("sha256")
      .update("session-1:call-1")
      .digest("hex")
      .slice(0, 32);
    expect(insert.mock.calls[0]?.[1]).toEqual({ signal: ctx.abortSignal });
    expect(get).toHaveBeenCalledWith(
      { calendarId: "primary", eventId },
      { signal: ctx.abortSignal }
    );
  });

  it("warms the People search cache before the typed contact query", async () => {
    const ctx = toolContext();
    const searchContacts = vi
      .fn<
        (
          request: unknown,
          options: RequestOptions
        ) => Promise<{
          data: { results?: { person: { resourceName: string } }[] };
        }>
      >()
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({
        data: { results: [{ person: { resourceName: "people/1" } }] },
      });
    googleClients({ people: { people: { searchContacts } } });

    await expect(searchGoogleContacts(ctx, "Person", 10)).resolves.toEqual({
      contacts: [{ person: { resourceName: "people/1" } }],
    });

    expect(searchContacts).toHaveBeenNthCalledWith(
      1,
      {
        query: "",
        readMask: "names,emailAddresses,phoneNumbers,organizations",
      },
      { signal: ctx.abortSignal }
    );
    expect(searchContacts).toHaveBeenNthCalledWith(
      2,
      {
        pageSize: 10,
        query: "Person",
        readMask: "names,emailAddresses,phoneNumbers,organizations",
      },
      { signal: ctx.abortSignal }
    );
  });
});

function toolContext() {
  const getToken = vi
    .fn<ToolContext["getToken"]>()
    .mockResolvedValue({ token: "google-access-token" });
  const requireAuth = vi.fn<ToolContext["requireAuth"]>();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture supplies exactly the ToolContext fields exercised by these helpers.
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getToken,
    requireAuth,
    session: { id: "session-1" },
  } as unknown as ToolContext & {
    getToken: typeof getToken;
    requireAuth: typeof requireAuth;
  };
}

function googleClients(clients: {
  calendar?: unknown;
  gmail?: unknown;
  people?: unknown;
}) {
  google.calendar.mockReturnValue(clients.calendar ?? {});
  google.gmail.mockReturnValue(clients.gmail ?? {});
  google.people.mockReturnValue(clients.people ?? {});
}

class GoogleApiError extends Error {
  readonly response: { status: number };

  constructor(status: number) {
    super(`Google API returned ${String(status)}`);
    this.response = { status };
  }
}

function gmailOtpMessage(body: string) {
  return {
    id: "m1",
    internalDate: String(Date.now()),
    payload: {
      body: { data: Buffer.from(body, "utf8").toString("base64url") },
      headers: [
        { name: "From", value: "Workday <noreply@myworkday.com>" },
        { name: "Subject", value: "Your verification code" },
        { name: "Date", value: "Fri, 29 Aug 2026 06:00:00 +0000" },
      ],
      mimeType: "text/plain",
    },
  };
}
