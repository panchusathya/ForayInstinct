import { readFileSync } from "node:fs";
import {
  getTokenResponse,
  NoValidTokenError,
  type ConnectTokenResponse,
  startAuthorization,
} from "@vercel/connect";
import type * as VercelConnect from "@vercel/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addLocalDays,
  eventOverlapsDay,
  localDateInTimeZone,
  parseCalendarAvailability,
  zonedDayBounds,
} from "@/agent/lib/google-workspace/calendar";
import { googleWorkspaceAuthOptions } from "@/agent/lib/google-workspace/client";
import { gmailUpdateLabels } from "@/agent/lib/google-workspace/gmail";
import { googleWorkspaceWriteApproval } from "@/agent/tools/google_workspace_write";
import { env } from "@/lib/env";
import {
  GOOGLE_WORKSPACE_SCOPES,
  googleWorkspaceSubject,
  googleWorkspaceTokenParams,
} from "@/lib/google-workspace/config";
import {
  getGoogleWorkspaceConnection,
  startGoogleWorkspaceAuthorization,
} from "@/lib/google-workspace/server";

vi.mock("@vercel/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof VercelConnect>()),
  getTokenResponse: vi.fn<typeof getTokenResponse>(),
  startAuthorization: vi.fn<typeof startAuthorization>(),
}));

afterEach(() => vi.clearAllMocks());

const scope = {
  userId: "better-auth:user-123",
  workspaceId: "personal:workspace-123",
};

describe("Google Workspace connection", () => {
  it("uses one explicit least-privilege scope set", () => {
    expect(GOOGLE_WORKSPACE_SCOPES).not.toContain("*");
    expect(GOOGLE_WORKSPACE_SCOPES).not.toContain("https://mail.google.com/");
    expect(googleWorkspaceTokenParams(scope.userId)).toEqual({
      scopes: [...GOOGLE_WORKSPACE_SCOPES],
      subject: googleWorkspaceSubject(scope.userId),
    });
    expect(googleWorkspaceAuthOptions.tokenParams).toEqual({
      scopes: [...GOOGLE_WORKSPACE_SCOPES],
    });
    expect(googleWorkspaceAuthOptions.validate).toBe(true);
  });

  it("uses the same user subject for manager and Eve flows", () => {
    expect(googleWorkspaceSubject(scope.userId)).toEqual({
      id: scope.userId,
      issuer: "openinstinct",
      type: "user",
    });
  });

  it("forwards one principal id from every surface so Connect sees one subject", () => {
    const webChannel = readFileSync("agent/channels/eve.ts", "utf8");
    const linqChannel = readFileSync("agent/channels/linq-v2.ts", "utf8");
    const schedule = readFileSync(
      "agent/schedules/goforay-role-searches.ts",
      "utf8"
    );

    // createSubject derives the Connect subject from the forwarded principal
    // id, so a surface that forwards anything else cannot see a Google grant
    // made from the web: it mints a fresh pairing code on every Gmail call.
    expect(webChannel).toContain("principalId: scope.userId");
    expect(schedule).toContain("principalId: delivery.scope.userId");
    expect(linqChannel).toContain("principalId: scope.userId");
    expect(linqChannel).not.toContain("principalId: auth.principalId");
  });

  it("reports connected accounts without exposing tokens", async () => {
    const response: ConnectTokenResponse = {
      claims: { email: "person@example.com" },
      connector: { id: "connector-id", type: "oauth", uid: "google/test" },
      expiresAt: Date.now() + 60_000,
      token: "must-not-leak",
    };
    vi.mocked(getTokenResponse).mockResolvedValue(response);

    await expect(getGoogleWorkspaceConnection(scope)).resolves.toEqual({
      accountLabel: "person@example.com",
      state: "connected",
    });
    expect(getTokenResponse).toHaveBeenCalledWith(
      expect.any(String),
      googleWorkspaceTokenParams(scope.userId),
      { forceRefresh: true }
    );
  });

  it("reports a missing user grant as disconnected", async () => {
    vi.mocked(getTokenResponse).mockRejectedValue(
      new NoValidTokenError("No Google grant for this user.")
    );
    await expect(getGoogleWorkspaceConnection(scope)).resolves.toEqual({
      accountLabel: null,
      state: "disconnected",
    });
  });

  it("names the connector when setup, not the user grant, is missing", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.mocked(getTokenResponse).mockRejectedValue(
      new Error("Connector google/open-instinct is not attached.")
    );

    await expect(getGoogleWorkspaceConnection(scope)).resolves.toEqual({
      accountLabel: null,
      state: "unavailable",
    });
    expect(logged).toHaveBeenCalledWith(
      "[google-workspace] connector unavailable",
      {
        connectorUid: env.GOOGLE_CONNECTOR_UID,
        error: "Connector google/open-instinct is not attached.",
        workspaceId: scope.workspaceId,
      }
    );
    logged.mockRestore();
  });

  it("starts authorization with the canonical subject and scopes", async () => {
    vi.mocked(startAuthorization).mockResolvedValue({
      request: "request",
      url: "https://connect.vercel.com/request",
      verifier: "verifier",
    });

    await expect(
      startGoogleWorkspaceAuthorization(
        scope,
        "https://openinstinct.example/?google=connected"
      )
    ).resolves.toBe("https://connect.vercel.com/request");
    expect(startAuthorization).toHaveBeenCalledWith(
      expect.any(String),
      googleWorkspaceTokenParams(scope.userId),
      expect.objectContaining({
        callbackUrl: "https://openinstinct.example/?google=connected",
      })
    );
  });

  it("bounds a local day by the calendar's timezone, not UTC", () => {
    // The bug this replaces: the agent built 2026-08-30 as a UTC day, so an
    // evening event in Los Angeles fell into the next UTC day and vanished.
    const { end, start } = zonedDayBounds("2026-08-30", "America/Los_Angeles");
    expect(start.toISOString()).toBe("2026-08-30T07:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-31T07:00:00.000Z");

    const kolkata = zonedDayBounds("2026-08-30", "Asia/Kolkata");
    expect(kolkata.start.toISOString()).toBe("2026-08-29T18:30:00.000Z");
  });

  it("bounds a local day across a DST transition", () => {
    // US DST ends 2026-11-01, so that local day is 25 hours long.
    const { end, start } = zonedDayBounds("2026-11-01", "America/Los_Angeles");
    expect(start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("reads the local date and shifts it by whole days", () => {
    const evening = new Date("2026-08-30T01:12:00.000Z");
    expect(localDateInTimeZone(evening, "America/Los_Angeles")).toBe(
      "2026-08-29"
    );
    expect(localDateInTimeZone(evening, "UTC")).toBe("2026-08-30");
    expect(addLocalDays("2026-08-29", 1)).toBe("2026-08-30");
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("keeps an evening event that a UTC-bounded day would drop", () => {
    const { end, start } = zonedDayBounds("2026-08-30", "America/Los_Angeles");
    const evening = {
      end: { dateTime: "2026-08-30T20:00:00-07:00" },
      start: { dateTime: "2026-08-30T19:00:00-07:00" },
    };
    expect(eventOverlapsDay(evening, "2026-08-30", start, end)).toBe(true);

    const nextDay = {
      end: { dateTime: "2026-08-31T10:00:00-07:00" },
      start: { dateTime: "2026-08-31T09:00:00-07:00" },
    };
    expect(eventOverlapsDay(nextDay, "2026-08-30", start, end)).toBe(false);
  });

  it("treats an all-day event's end date as exclusive", () => {
    const { end, start } = zonedDayBounds("2026-08-30", "America/Los_Angeles");
    const spanning = {
      end: { date: "2026-08-31" },
      start: { date: "2026-08-29" },
    };
    expect(eventOverlapsDay(spanning, "2026-08-30", start, end)).toBe(true);

    const endsBefore = {
      end: { date: "2026-08-30" },
      start: { date: "2026-08-29" },
    };
    expect(eventOverlapsDay(endsBefore, "2026-08-30", start, end)).toBe(false);
  });

  it("maps reversible Gmail actions to system labels", () => {
    expect(gmailUpdateLabels("archive")).toEqual({
      addLabelIds: [],
      removeLabelIds: ["INBOX"],
    });
    expect(gmailUpdateLabels("mark_unread")).toEqual({
      addLabelIds: ["UNREAD"],
      removeLabelIds: [],
    });
  });

  it("requires approval for consequential writes only", () => {
    expect(googleWorkspaceWriteApproval("update_email")).toBe("not-applicable");
    expect(googleWorkspaceWriteApproval("send_email")).toBe("user-approval");
    expect(googleWorkspaceWriteApproval("create_calendar_event")).toBe(
      "user-approval"
    );
  });

  it("does not interpret Google FreeBusy errors as availability", () => {
    expect(() =>
      parseCalendarAvailability({
        calendars: {
          "missing@example.com": {
            errors: [{ domain: "global", reason: "notFound" }],
          },
        },
      })
    ).toThrow(/missing@example\.com: notFound/u);

    expect(
      parseCalendarAvailability({
        calendars: {
          primary: {
            busy: [
              {
                end: "2026-08-27T15:00:00-04:00",
                start: "2026-08-27T14:00:00-04:00",
              },
            ],
          },
        },
      })
    ).toEqual({
      calendars: {
        primary: {
          busy: [
            {
              end: "2026-08-27T15:00:00-04:00",
              start: "2026-08-27T14:00:00-04:00",
            },
          ],
        },
      },
    });
  });
});
