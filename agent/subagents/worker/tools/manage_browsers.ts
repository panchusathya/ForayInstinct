import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  createBrowserSession,
  deleteBrowserSession,
  listBrowserSessions,
} from "@/db/services/browsers";
import {
  browserTimeoutFloorSeconds,
  clampBrowserTimeoutSeconds,
  createRemoteBrowser,
  describeRemoteBrowser,
  extendRemoteBrowserKeepAlive,
  forgetRemoteBrowser,
  updateRemoteBrowserViewport,
  type BrowserDescriptor,
} from "@/lib/browser";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import { withWorkerToolError } from "@/agent/lib/worker-tool-error";

const inputSchema = z.object({
  action: z.enum(["create", "update", "list", "get", "delete"]),
  session_id: z.string().optional(),
  start_url: z.url().optional(),
  timeout_seconds: z
    .number()
    .int()
    .min(browserTimeoutFloorSeconds)
    .max(259_200)
    .optional(),
  viewport_width: z.number().int().min(1).optional(),
  viewport_height: z.number().int().min(1).optional(),
  status: z.enum(["active", "deleted", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export default defineTool({
  description:
    'Manage persisted browser sessions. Create one session and reuse its session_id for the assignment; each browser tool call launches Chromium through the same Decodo sticky residential route and restores saved state. timeout_seconds defaults to 15 minutes and is capped at 60. Use "list" or "get" to inspect sessions, "update" to extend timeout_seconds, and "delete" when finished.',
  inputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);

    return withWorkerToolError(
      "manage_browsers",
      input.session_id,
      async () => {
        switch (input.action) {
          case "create": {
            const viewport = browserViewport(input);
            const browser = await createRemoteBrowser({
              startUrl: input.start_url,
              timeoutSeconds: clampBrowserTimeoutSeconds(input.timeout_seconds),
              viewport,
            });
            await createBrowserSession(scope, {
              createdAt: browser.created_at,
              sessionId: browser.session_id,
            });
            return lifecycleResult(browser);
          }
          case "list": {
            const records = await listBrowserSessions(scope);
            const offset = input.offset ?? 0;
            const limit = input.limit ?? 100;
            const browsers = await Promise.all(
              records.map(async ({ sessionId }) => {
                try {
                  return await describeRemoteBrowser(sessionId);
                } catch {
                  return input.status === "deleted"
                    ? {
                        browser_live_view_url: "",
                        session_id: sessionId,
                        status: "deleted" as const,
                      }
                    : null;
                }
              })
            );
            return {
              has_more: false,
              items: browsers
                .filter((browser) => browser !== null)
                .filter((browser) =>
                  input.status === "deleted"
                    ? browser.status === "deleted"
                    : input.status === "active"
                      ? browser.status === "active"
                      : true
                )
                .slice(offset, offset + limit),
              next_offset: null,
            };
          }
          case "get": {
            const sessionId = requireSessionId(input.session_id);
            await requireOwnedBrowserSession(scope, sessionId);
            return describeRemoteBrowser(sessionId);
          }
          case "update": {
            const sessionId = requireSessionId(input.session_id);
            await requireOwnedBrowserSession(scope, sessionId);
            if (input.timeout_seconds !== undefined) {
              await extendRemoteBrowserKeepAlive(
                sessionId,
                input.timeout_seconds
              );
            }
            const viewport = browserViewport(input);
            const browser = viewport
              ? await updateRemoteBrowserViewport(sessionId, viewport)
              : await describeRemoteBrowser(sessionId);
            return lifecycleResult(browser);
          }
          case "delete": {
            const sessionId = requireSessionId(input.session_id);
            await requireOwnedBrowserSession(scope, sessionId);
            await forgetRemoteBrowser(sessionId);
            await deleteBrowserSession(scope, sessionId);
            return "Browser session deleted successfully";
          }
        }
      }
    );
  },
});

function requireSessionId(sessionId: string | undefined) {
  if (!sessionId) throw new Error("A browser session ID is required.");
  return sessionId;
}

function browserViewport(input: z.infer<typeof inputSchema>) {
  const height = input.viewport_height;
  const width = input.viewport_width;
  if (height === undefined && width === undefined) return undefined;
  if (height === undefined || width === undefined) {
    throw new Error("Viewport width and height must be provided together.");
  }
  return { height, width };
}

function lifecycleResult(browser: BrowserDescriptor) {
  return {
    browser,
    next_actions: [
      `Use execute_playwright_code with session_id "${browser.session_id}" for deterministic browser automation.`,
      `Use computer_action with session_id "${browser.session_id}" for visual browser control.`,
      `Use manage_browsers with action "delete" and session_id "${browser.session_id}" when finished.`,
    ],
  };
}
