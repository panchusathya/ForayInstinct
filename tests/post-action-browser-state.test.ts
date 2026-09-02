import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  postActionBrowserStateInstruction,
  postActionBrowserStateProbeCode,
  type PostActionBrowserState,
} from "@/agent/subagents/worker/lib/post-action-browser-state";

describe("post-action browser inspection", () => {
  it("finds a Greenhouse email OTP from autocomplete=one-time-code in an iframe", async () => {
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
      submitted: false,
    });
    expect(postActionBrowserStateInstruction(result)).toContain(
      "Needs email OTP:"
    );
  });

  it("does not treat a zip-code field or OTP-ish page copy as an OTP", async () => {
    const result = await runProbe([
      frame({
        controls: [
          control({
            autocomplete: "postal-code",
            name: "zip",
            placeholder: "Enter your zip code",
          }),
        ],
        text: "Enter your zip code. We sent a verification code to continue.",
      }),
    ]);

    expect(result).toMatchObject({
      emailOtp: false,
      smsOtp: false,
      submitted: false,
    });
  });

  it("requires a visible CAPTCHA iframe, not recaptcha footer copy", async () => {
    const footer = await runProbe([
      frame({
        text: "This site is protected by reCAPTCHA and the Google Privacy Policy.",
      }),
    ]);
    expect(footer).toMatchObject({ botOrChallenge: false });
    expect(postActionBrowserStateInstruction(footer)).toBeUndefined();

    const challenge = await runProbe([
      frame({
        iframes: [
          iframeControl({
            height: 420,
            src: "https://www.google.com/recaptcha/api2/bframe?k=site",
            width: 360,
          }),
        ],
      }),
    ]);
    expect(challenge).toMatchObject({ botOrChallenge: true });
    expect(postActionBrowserStateInstruction(challenge)).toContain(
      "do not refill or retry"
    );
  });

  it("does not mark submitted from posting-page copy", async () => {
    const result = await runProbe([
      frame({
        href: "https://boards.greenhouse.io/acme/jobs/1/apply",
        text: "Thank you. We have received your application.",
      }),
    ]);
    expect(result).toMatchObject({ submitted: false });
  });

  it("marks submitted from a confirmation URL", async () => {
    const result = await runProbe([
      frame({
        href: "https://intapp.wd1.myworkdayjobs.com/en-US/Intapp/job/role/apply/applicationSubmitted",
        text: "",
      }),
    ]);
    expect(result).toMatchObject({ submitted: true });
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vm.Script returns the in-page probe object.
  return new Script(
    `(async () => {${postActionBrowserStateProbeCode}})()`
  ).runInNewContext({ browser }) as Promise<PostActionBrowserState>;
}

function frame({
  controls = [],
  href,
  hostname = "example.com",
  iframes = [],
  text = "",
}: {
  controls?: ReturnType<typeof control>[];
  href?: string;
  hostname?: string;
  iframes?: ReturnType<typeof iframeControl>[];
  text?: string;
}) {
  const locationHref = href ?? `https://${hostname}/apply`;
  return {
    async evaluate(fn: () => unknown) {
      // oxlint-disable-next-line typescript/no-unsafe-return -- vm.Script evaluates the in-page probe against this mock DOM.
      return new Script(`(${fn.toString()})()`).runInNewContext({
        document: {
          body: { innerText: text },
          querySelectorAll: (selector: string) => {
            if (selector.includes("iframe")) return iframes;
            return controls;
          },
        },
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        location: {
          href: locationHref,
          hostname: new URL(locationHref).hostname,
        },
      });
    },
  };
}

function control(attributes: Record<string, string>) {
  return {
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    getBoundingClientRect: () => ({ height: 24, width: 180 }),
  };
}

function otpControl() {
  return control({ autocomplete: "one-time-code" });
}

function iframeControl({
  height,
  src,
  width,
}: {
  height: number;
  src: string;
  width: number;
}) {
  return {
    getAttribute(name: string) {
      return name === "src" ? src : null;
    },
    getBoundingClientRect: () => ({ height, width }),
    src,
  };
}
