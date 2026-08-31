/** Linq protocol on a Chat SDK thread. Empty means we have never been told. */

export function normalizeLinqService(value: unknown) {
  if (typeof value !== "string") return "";
  const key = value.trim().toLowerCase();
  if (key === "imessage") return "iMessage";
  if (key === "rcs") return "RCS";
  if (key === "sms" || key === "mms") return "SMS";
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function linqServiceFromUnknown(value: unknown): string {
  if (!isRecord(value)) return "";
  for (const candidate of [
    value.service,
    value.lastService,
    value.last_service,
  ]) {
    const service = normalizeLinqService(candidate);
    if (service) return service;
  }
  for (const nested of [
    value.currentMessage,
    value.raw,
    value.sender_handle,
    value.from_handle,
    value.chat,
  ]) {
    const service = linqServiceFromUnknown(nested);
    if (service) return service;
  }
  return "";
}

export function isRichLinqService(service: string) {
  return service === "iMessage" || service === "RCS";
}
