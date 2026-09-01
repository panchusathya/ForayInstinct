import { z } from "zod";
import type { CdpPageHandle } from "@/lib/browser/provider";
import { kernel } from "@/lib/kernel";

/**
 * Kernel's flat CDP transport: a second WebSocket onto the session's
 * `cdp_ws_url`, with the current page target and its out-of-process iframes
 * attached. The gateway provider offers the same `CdpPageHandle` over HTTP,
 * so callers never see which transport they are on.
 */
export async function withKernelCdpPage<T>(
  browserSessionId: string,
  operation: (page: CdpPageHandle) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const browser = await kernel.browsers.retrieve(
    browserSessionId,
    {},
    { signal }
  );
  const connection = await CdpConnection.connect(browser.cdp_ws_url, signal);

  try {
    const { targetInfos } = targetListSchema.parse(
      await connection.send("Target.getTargets")
    );
    const target = targetInfos.findLast(
      ({ type, url }) => type === "page" && isWebUrl(url)
    );
    if (!target) throw new Error("No active browser tab was found.");

    const { sessionId: pageSessionId } = attachedTargetSchema.parse(
      await connection.send("Target.attachToTarget", {
        flatten: true,
        targetId: target.targetId,
      })
    );
    const sessionIds = [pageSessionId];
    try {
      await connection.send("Page.enable", undefined, pageSessionId);
      const { frameTree } = frameTreeSchema.parse(
        await connection.send("Page.getFrameTree", undefined, pageSessionId)
      );
      const frameIds = new Set(flattenFrames(frameTree).map(({ id }) => id));
      const iframeTargets = targetInfos.filter(
        ({ targetId, type }) => type === "iframe" && frameIds.has(targetId)
      );
      for (const iframeTarget of iframeTargets) {
        const attached = attachedTargetSchema.safeParse(
          await connection
            .send("Target.attachToTarget", {
              flatten: true,
              targetId: iframeTarget.targetId,
            })
            .catch(() => undefined)
        );
        if (attached.success) sessionIds.push(attached.data.sessionId);
      }

      return await operation({
        origin: new URL(target.url).origin,
        send: (method, params, sessionRef) =>
          connection.send(method, params, sessionRef),
        sessionRefs: sessionIds,
        url: target.url,
      });
    } finally {
      await Promise.all(
        sessionIds.map((sessionId) =>
          connection
            .send("Target.detachFromTarget", { sessionId })
            .catch(() => undefined)
        )
      );
    }
  } finally {
    connection.close();
  }
}

const targetListSchema = z.object({
  targetInfos: z.array(
    z.object({
      targetId: z.string(),
      type: z.string(),
      url: z.string(),
    })
  ),
});

const attachedTargetSchema = z.object({ sessionId: z.string() });

const frameTreeSchema = z.object({
  frameTree: z.lazy(() => frameTreeNodeSchema),
});
const frameTreeNodeSchema: z.ZodType<{
  childFrames?: z.infer<typeof frameTreeNodeSchema>[];
  frame: { id: string; url: string };
}> = z.object({
  childFrames: z.array(z.lazy(() => frameTreeNodeSchema)).optional(),
  frame: z.object({ id: z.string(), url: z.string() }),
});

function flattenFrames(
  node: z.infer<typeof frameTreeNodeSchema>
): { readonly id: string; readonly url: string }[] {
  return [
    node.frame,
    ...(node.childFrames ?? []).flatMap((child) => flattenFrames(child)),
  ];
}

function isWebUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

class CdpConnection {
  readonly #pending = new Map<
    number,
    {
      readonly reject: (reason?: unknown) => void;
      readonly resolve: (value: unknown) => void;
    }
  >();
  #nextId = 1;

  private constructor(
    private readonly socket: WebSocket,
    signal: AbortSignal | undefined
  ) {
    socket.addEventListener("message", (event) => {
      this.#onMessage(event);
    });
    socket.addEventListener("close", () => {
      this.#rejectPending(new Error("The Kernel CDP connection closed."));
    });
    signal?.addEventListener(
      "abort",
      () => {
        this.close();
      },
      { once: true }
    );
  }

  static async connect(url: string, signal?: AbortSignal) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not connect to the Kernel browser over CDP."));
      };
      const onAbort = () => {
        cleanup();
        socket.close();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("The CDP connection was aborted.")
        );
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return new CdpConnection(socket, signal);
  }

  send(method: string, params?: object, sessionId?: string) {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Chromium did not respond to ${method}.`));
      }, 15_000);
      this.#pending.set(id, {
        reject(reason) {
          clearTimeout(timeout);
          reject(
            reason instanceof Error
              ? reason
              : new Error("The Chromium command failed.")
          );
        },
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.socket.close();
  }

  #onMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(event.data);
    } catch {
      return;
    }
    const message = cdpMessageSchema.safeParse(rawMessage);
    if (!message.success || message.data.id === undefined) return;
    const pending = this.#pending.get(message.data.id);
    if (!pending) return;
    this.#pending.delete(message.data.id);
    if (message.data.error) {
      pending.reject(new Error(message.data.error.message));
    } else {
      pending.resolve(message.data.result);
    }
  }

  #rejectPending(error: Error) {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}

const cdpMessageSchema = z.object({
  error: z.object({ message: z.string() }).optional(),
  id: z.number().int().optional(),
  result: z.unknown().optional(),
});
