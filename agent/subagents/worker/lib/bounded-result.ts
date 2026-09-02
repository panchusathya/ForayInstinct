/**
 * Model-facing caps for values the worker's own Playwright code chose to
 * return. eve has no tool-result truncation, and a `page.content()` or an
 * `$$eval` over every node lands in the vision model's 65k effective window
 * whole. The cap lives at the one tool whose result shape the model controls.
 */
export const playwrightResultMaxChars = 4_000;
export const playwrightErrorMaxChars = 800;

/** Returns `value` unchanged when it fits, otherwise a marked, sliced string. */
export function boundResultText(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : serialize(value);
  if (text.length <= maxChars) return value;
  return `${text.slice(0, maxChars)}\n… [truncated: ${String(text.length)} characters, ${String(maxChars)} shown. Return only the fields you need from Playwright code, such as a short object of labels, values, and URLs, not page HTML or full element lists.]`;
}

function serialize(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    // Cycles and BigInt cannot be stringified; the fallback still bounds them.
    return String(value);
  }
}
