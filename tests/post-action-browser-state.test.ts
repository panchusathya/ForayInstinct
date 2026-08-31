import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  postActionBrowserStateInstruction,
  postActionBrowserStateProbeCode,
  type PostActionBrowserState,
} from "@/agent/subagents/worker/lib/post-action-browser-state";

describe("post-action browser inspection", () => {
  it("finds a Greenhouse email OTP in an iframe, not only the active page", async () => {
    const result = await runProbe([
      frame({ text: "Application submitted. Continue." }),
      frame({
        controls: [otpControl()],
        hostname: "boards.greenhouse.io",
        text: "We sent a verification code to your email inbox.",
      }),
    ]);

    expect(result).toMatchObject({
      emailOtp: true,
      otpHint: "Greenhouse",
      smsOtp: false,
      submitted: true,
    });
    expect(postActionBrowserStateInstruction(result)).toContain(
      "Needs email OTP:"
    );
  });

  it("marks a bot error as a blocker rather than a retry signal", async () => {
    const result = await runProbe([
      frame({ text: "Bot detection error. Verify you are human to continue." }),
    ]);

    expect(result).toMatchObject({ botOrChallenge: true });
    expect(postActionBrowserStateInstruction(result)).toContain(
      "do not refill or retry"
    );
  });

  it("keeps the worker rules explicit about never resubmitting after OTP", async () => {
    const instructions = await import("node:fs/promises").then(({ readFile }) =>
      readFile("agent/subagents/worker/instructions.md", "utf8")
    );

    expect(instructions).toContain("After **any** application");
    expect(instructions).toContain("Do not refill,");
    expect(instructions).toContain("resubmit, screenshot, or retry");
  });
});

async function runProbe(frames: ReturnType<typeof frame>[]) {
  const browser = {
    contexts: () => [
      {
        pages: () => [
          {
            frames: () => frames,
          },
        ],
      },
    ],
  };
  return new Script(
    `(async () => {${postActionBrowserStateProbeCode}})()`
  ).runInNewContext({ browser }) as Promise<PostActionBrowserState>;
}

function frame({
  controls = [],
  hostname = "example.com",
  text = "",
}: {
  controls?: ReturnType<typeof otpControl>[];
  hostname?: string;
  text?: string;
}) {
  return {
    async evaluate(fn: () => unknown) {
      return new Script(`(${fn.toString()})()`).runInNewContext({
        document: {
          body: { innerText: text },
          querySelectorAll: () => controls,
        },
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        location: { href: `https://${hostname}/apply`, hostname },
      });
    },
  };
}

function otpControl() {
  return {
    getAttribute(name: string) {
      return name === "autocomplete" ? "one-time-code" : null;
    },
    getBoundingClientRect: () => ({ height: 24, width: 180 }),
  };
}
