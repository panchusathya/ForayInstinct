import { createHash } from "node:crypto";
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import { people } from "@googleapis/people";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { googleApiErrorStatus, withGoogleAuth } from "./client";

export const calendarEventSchema = z.object({
  attendees: z.array(z.email()).max(50).default([]),
  calendarId: z.string().default("primary"),
  description: z.string().max(8_000).optional(),
  end: z.iso.datetime({ offset: true }),
  location: z.string().max(1_000).optional(),
  start: z.iso.datetime({ offset: true }),
  summary: z.string().min(1).max(1_000),
  timezone: z.string().min(1).default("UTC"),
});

export async function listCalendarEvents(
  ctx: ToolContext,
  input: {
    calendarId: string;
    maxResults: number;
    timeMax: string;
    timeMin: string;
  }
) {
  return withCalendar(ctx, async (client) => {
    const { data } = await client.events.list(
      {
        calendarId: input.calendarId,
        fields:
          "timeZone,items(id,status,summary,description,location,start,end,attendees(email,responseStatus),htmlLink)",
        maxResults: input.maxResults,
        orderBy: "startTime",
        singleEvents: true,
        timeMax: input.timeMax,
        timeMin: input.timeMin,
      },
      { signal: ctx.abortSignal }
    );
    return { events: data.items ?? [], timeZone: data.timeZone ?? "UTC" };
  });
}

/**
 * The agent runs serverless with no clock and no knowledge of the user's
 * timezone, so it cannot turn "tomorrow" into an absolute window: it reasons in
 * UTC and silently reads the wrong day. Resolve a relative day here instead,
 * against the timezone the calendar itself reports.
 */
export async function listCalendarEventsForDay(
  ctx: ToolContext,
  input: { calendarId: string; dayOffset: number; maxResults: number }
) {
  // The target local day sits within a day of the same offset applied in UTC,
  // so this window covers it whatever the calendar's timezone turns out to be.
  const approximate = Date.now() + input.dayOffset * DAY_MS;
  const { events, timeZone } = await listCalendarEvents(ctx, {
    calendarId: input.calendarId,
    // Widened queries return neighbouring days that are filtered out below, so
    // ask for more than the caller wants and trim afterwards.
    maxResults: Math.min(input.maxResults * 3, 250),
    timeMax: new Date(approximate + 2 * DAY_MS).toISOString(),
    timeMin: new Date(approximate - DAY_MS).toISOString(),
  });

  const localDate = addLocalDays(
    localDateInTimeZone(new Date(), timeZone),
    input.dayOffset
  );
  const { end, start } = zonedDayBounds(localDate, timeZone);
  return {
    events: events
      .filter((event) => eventOverlapsDay(event, localDate, start, end))
      .slice(0, input.maxResults),
    localDate,
    timeZone,
  };
}

const DAY_MS = 86_400_000;

/** The calendar-local calendar date of an instant, as YYYY-MM-DD. */
export function localDateInTimeZone(instant: Date, timeZone: string) {
  const parts = zonedParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addLocalDays(localDate: string, days: number) {
  const shifted = new Date(`${localDate}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** The UTC instants bounding a calendar-local day. */
export function zonedDayBounds(localDate: string, timeZone: string) {
  return {
    end: zonedMidnight(addLocalDays(localDate, 1), timeZone),
    start: zonedMidnight(localDate, timeZone),
  };
}

function zonedMidnight(localDate: string, timeZone: string) {
  const naive = Date.parse(`${localDate}T00:00:00Z`);
  // The offset depends on the instant, and the instant depends on the offset.
  // One refinement settles it, including across a DST transition.
  let instant = naive - zonedOffsetMs(new Date(naive), timeZone);
  instant = naive - zonedOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

function zonedOffsetMs(instant: Date, timeZone: string) {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - instant.getTime();
}

function zonedParts(instant: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });
  const found = new Map(
    formatter.formatToParts(instant).map((part) => [part.type, part.value])
  );
  const read = (type: Intl.DateTimeFormatPartTypes) => found.get(type) ?? "0";
  return {
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    month: read("month"),
    second: read("second"),
    year: read("year"),
  };
}

/**
 * All-day events carry `date` (with an exclusive end) rather than `dateTime`,
 * so they are compared as calendar dates and timed events as instants.
 */
export function eventOverlapsDay(
  event: calendar_v3.Schema$Event,
  localDate: string,
  dayStart: Date,
  dayEnd: Date
) {
  const allDayStart = event.start?.date;
  if (allDayStart) {
    const allDayEnd = event.end?.date ?? addLocalDays(allDayStart, 1);
    return allDayStart <= localDate && localDate < allDayEnd;
  }
  const startedAt = event.start?.dateTime;
  if (!startedAt) return false;
  const start = new Date(startedAt);
  const end = new Date(event.end?.dateTime ?? startedAt);
  return start < dayEnd && end > dayStart;
}

export async function checkCalendarAvailability(
  ctx: ToolContext,
  input: {
    calendars: string[];
    timeMax: string;
    timeMin: string;
    timezone: string;
  }
) {
  return withCalendar(ctx, async (client) => {
    const { data } = await client.freebusy.query(
      {
        requestBody: {
          items: input.calendars.map((id) => ({ id })),
          timeMax: input.timeMax,
          timeMin: input.timeMin,
          timeZone: input.timezone,
        },
      },
      { signal: ctx.abortSignal }
    );
    return parseCalendarAvailability(data);
  });
}

export function parseCalendarAvailability(
  value: calendar_v3.Schema$FreeBusyResponse
) {
  const failures = Object.entries(value.calendars ?? {}).flatMap(
    ([calendarId, calendar]) =>
      (calendar.errors ?? []).map(
        (error) => `${calendarId}: ${error.reason ?? error.domain ?? "unknown"}`
      )
  );
  if (failures.length > 0) {
    throw new Error(
      `Google Calendar could not read availability for ${failures.join(", ")}.`
    );
  }
  return value;
}

export async function createCalendarEvent(
  ctx: ToolContext,
  payload: z.infer<typeof calendarEventSchema>
) {
  const eventId = createHash("sha256")
    .update(`${ctx.session.id}:${ctx.callId}`)
    .digest("hex")
    .slice(0, 32);
  return withCalendar(ctx, async (client) => {
    try {
      const { data } = await client.events.insert(
        {
          calendarId: payload.calendarId,
          requestBody: {
            attendees: payload.attendees.map((email) => ({ email })),
            description: payload.description,
            end: { dateTime: payload.end, timeZone: payload.timezone },
            id: eventId,
            location: payload.location,
            start: { dateTime: payload.start, timeZone: payload.timezone },
            status: "confirmed",
            summary: payload.summary,
            visibility: "private",
          },
          sendUpdates: payload.attendees.length ? "all" : "none",
        },
        { signal: ctx.abortSignal }
      );
      return data;
    } catch (error) {
      if (googleApiErrorStatus(error) !== 409) throw error;
      const { data } = await client.events.get(
        { calendarId: payload.calendarId, eventId },
        { signal: ctx.abortSignal }
      );
      return data;
    }
  });
}

export async function searchGoogleContacts(
  ctx: ToolContext,
  query: string,
  pageSize: number
) {
  const readMask = "names,emailAddresses,phoneNumbers,organizations";
  return withGoogleAuth(ctx, async (auth) => {
    const client = people({ auth, version: "v1" });
    const options = { signal: ctx.abortSignal };
    await client.people.searchContacts({ query: "", readMask }, options);
    const { data } = await client.people.searchContacts(
      { pageSize, query, readMask },
      options
    );
    return { contacts: data.results ?? [] };
  });
}

function withCalendar<T>(
  ctx: ToolContext,
  execute: (client: ReturnType<typeof calendar>) => Promise<T>
) {
  return withGoogleAuth(ctx, (auth) =>
    execute(calendar({ auth, version: "v3" }))
  );
}
