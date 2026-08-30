import { calendar } from "@googleapis/calendar";
import { auth } from "@googleapis/gmail";
import { getTokenResponse } from "@vercel/connect";
import type { AccessScope } from "@/lib/access-scope";
import { env } from "@/lib/env";
import {
  eventOverlapsDay,
  localDateInTimeZone,
  zonedDayBounds,
} from "@/agent/lib/google-workspace/calendar";
import { getGoogleWorkspaceConnection } from "./server";
import { googleWorkspaceTokenParams } from "./config";

const DAY_MS = 86_400_000;

export async function prefetchGoogleWorkspaceContext(scope: AccessScope) {
  const connection = await getGoogleWorkspaceConnection(scope);
  if (connection.state !== "connected") {
    return {
      accountLabel: connection.accountLabel,
      events: [] as const,
      localDate: null,
      state: connection.state,
      timeZone: null,
    };
  }

  try {
    const token = await getTokenResponse(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(scope.userId),
      { forceRefresh: true }
    );
    const authClient = new auth.OAuth2();
    authClient.setCredentials({ access_token: token.token });
    const client = calendar({ auth: authClient, version: "v3" });
    const approximate = Date.now();
    const { data } = await client.events.list({
      calendarId: "primary",
      fields: "timeZone,items(id,status,summary,start,end,location,htmlLink)",
      maxResults: 15,
      orderBy: "startTime",
      singleEvents: true,
      timeMax: new Date(approximate + 2 * DAY_MS).toISOString(),
      timeMin: new Date(approximate - DAY_MS).toISOString(),
    });
    const timeZone = data.timeZone ?? "UTC";
    const localDate = localDateInTimeZone(new Date(), timeZone);
    const { end, start } = zonedDayBounds(localDate, timeZone);
    return {
      accountLabel: connection.accountLabel,
      events: (data.items ?? [])
        .filter((event) => eventOverlapsDay(event, localDate, start, end))
        .slice(0, 5)
        .map((event) => ({
          end: event.end?.dateTime ?? event.end?.date ?? null,
          location: event.location ?? null,
          start: event.start?.dateTime ?? event.start?.date ?? null,
          summary: event.summary ?? "(no title)",
        })),
      localDate,
      state: connection.state,
      timeZone,
    };
  } catch (error) {
    console.error("[google-workspace] calendar prefetch failed", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: scope.workspaceId,
    });
    return {
      accountLabel: connection.accountLabel,
      events: [] as const,
      localDate: null,
      state: connection.state,
      timeZone: null,
    };
  }
}
