import { z } from "zod";
import type { CDPSession } from "playwright-core";
import { withRemotePage } from "../../browser";
import type { AutofillClaim } from "../vault-autofill-protocol";
import {
  classifyNativeLoginControl,
  nativeLoginAutofillTokens,
  nativeLoginControlInspectionExpression,
  nativeLoginFillFunctionDeclaration,
  selectNativeLoginFills,
  type ClassifiedNativeLoginControl,
} from "./kernel-login-autofill";

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

const isolatedWorldSchema = z.object({ executionContextId: z.number() });
const evaluatedValueSchema = z.object({
  result: z.object({ value: z.unknown() }),
});
const evaluatedBooleanSchema = z.object({
  result: z.object({ value: z.boolean() }),
});
const evaluatedObjectSchema = z.object({
  result: z.object({ objectId: z.string().optional() }),
});
const describedNodeSchema = z.object({
  node: z.object({ backendNodeId: z.number().int().positive() }),
});
const controlDescriptorsSchema = z.array(
  z.object({
    autocomplete: z.string(),
    focused: z.boolean(),
    index: z.number().int().nonnegative(),
  })
);
const loginControlDescriptorsSchema = z.array(
  z.object({
    autocomplete: z.string(),
    focused: z.boolean(),
    formIndex: z.number().int().nonnegative().nullable(),
    index: z.number().int().nonnegative(),
    label: z.string(),
    name: z.string(),
    type: z.string(),
  })
);

const cardTokens = [
  "cc-name",
  "cc-number",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
] as const;

const addressTokenToChromiumField = {
  name: "NAME_FULL",
  "street-address": "ADDRESS_HOME_STREET_ADDRESS",
  "address-line1": "ADDRESS_HOME_LINE1",
  "address-line2": "ADDRESS_HOME_LINE2",
  "address-level2": "ADDRESS_HOME_CITY",
  "address-level1": "ADDRESS_HOME_STATE",
  "postal-code": "ADDRESS_HOME_ZIP",
  country: "ADDRESS_HOME_COUNTRY",
} as const;

export const nativeAutofillTokens = {
  address: Object.keys(addressTokenToChromiumField),
  login: nativeLoginAutofillTokens,
  payment: [...cardTokens],
} as const;

type NativeAutofillKind = "address" | "login" | "payment";

export async function currentKernelPageOrigin({
  browserSessionId,
  signal,
}: {
  readonly browserSessionId: string;
  readonly signal?: AbortSignal;
}) {
  return withKernelPage(browserSessionId, signal, async ({ origin }) => origin);
}

export async function fillWithKernelNativeAutofill({
  browserSessionId,
  claims,
  expectedOrigin,
  kind,
  signal,
}: {
  readonly browserSessionId: string;
  readonly claims: readonly AutofillClaim[];
  readonly expectedOrigin: string;
  readonly kind: NativeAutofillKind;
  readonly signal?: AbortSignal;
}) {
  const payload =
    kind === "login" ? undefined : buildNativeAutofillPayload(kind, claims);

  return withKernelPage(
    browserSessionId,
    signal,
    async ({ connection, origin, sessionId }) => {
      if (origin !== expectedOrigin) {
        throw new Error(
          "The active tab no longer matches the approved origin."
        );
      }

      if (kind === "login") {
        const filledClaims = await fillNativeLoginControls(
          connection,
          sessionId,
          claims
        );
        return { filledClaims, origin };
      }

      const controls = await inspectControls(connection, sessionId, kind);
      if (controls.length === 0) {
        throw new Error("No visible form control is available for autofill.");
      }

      let lastError: unknown;
      for (const control of controls) {
        try {
          await connection.send(
            "Autofill.trigger",
            {
              fieldId: control.backendNodeId,
              frameId: control.frameId,
              ...payload,
            },
            control.sessionId
          );
          return { filledClaims: claims.length, origin };
        } catch (error) {
          lastError = error;
        }
      }

      throw new Error(
        "Chromium could not autofill any visible control. Focus a field in the intended card or address form and retry.",
        { cause: lastError }
      );
    }
  );
}

async function fillNativeLoginControls(
  connection: CdpConnection,
  sessionIds: readonly string[],
  claims: readonly AutofillClaim[]
) {
  const controls = await inspectNativeLoginControls(connection, sessionIds);
  const focused = controls.find((control) => control.focused);
  if (!focused) {
    throw new Error(
      "Focus a visible username, email, phone, or current-password field and retry."
    );
  }
  const sameFrame = controls.filter(
    (control) =>
      control.frameId === focused.frameId &&
      control.sessionId === focused.sessionId
  );
  const fills = selectNativeLoginFills(sameFrame, claims);
  if (fills.length === 0) {
    throw new Error(
      "The focused login form does not accept a field available in this saved login."
    );
  }

  for (const { control, value } of fills) {
    const accepted = await fillNativeLoginControl(connection, control, value);
    if (!accepted) {
      throw new Error("The login form rejected secure credential autofill.");
    }
  }
  return fills.length;
}

async function inspectNativeLoginControls(
  connection: CdpConnection,
  sessionIds: readonly string[]
) {
  return (
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await connection.send("Page.enable", undefined, sessionId);
          const { frameTree } = frameTreeSchema.parse(
            await connection.send("Page.getFrameTree", undefined, sessionId)
          );
          return (
            await Promise.all(
              flattenFrames(frameTree).map(({ id: frameId }) =>
                inspectNativeLoginFrame(connection, sessionId, frameId).catch(
                  () => []
                )
              )
            )
          ).flat();
        } catch {
          return [];
        }
      })
    )
  ).flat();
}

async function inspectNativeLoginFrame(
  connection: CdpConnection,
  sessionId: string,
  frameId: string
) {
  const { executionContextId } = isolatedWorldSchema.parse(
    await connection.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "open-instinct-login-autofill" },
      sessionId
    )
  );
  const response = evaluatedValueSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: executionContextId,
        expression: nativeLoginControlInspectionExpression,
        returnByValue: true,
      },
      sessionId
    )
  );
  const descriptors = loginControlDescriptorsSchema.parse(
    response.result.value
  );
  return descriptors.flatMap((descriptor) => {
    const classified = classifyNativeLoginControl(descriptor);
    return classified
      ? [{ ...classified, executionContextId, frameId, sessionId }]
      : [];
  });
}

async function fillNativeLoginControl(
  connection: CdpConnection,
  control: ClassifiedNativeLoginControl & {
    readonly executionContextId: number;
    readonly frameId: string;
    readonly sessionId: string;
  },
  value: string
) {
  const evaluated = evaluatedObjectSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: control.executionContextId,
        expression: `document.querySelectorAll("input").item(${String(control.index)})`,
      },
      control.sessionId
    )
  );
  const objectId = evaluated.result.objectId;
  if (!objectId) return false;

  try {
    const response = evaluatedBooleanSchema.parse(
      await connection.send(
        "Runtime.callFunctionOn",
        {
          arguments: [{ value }],
          awaitPromise: false,
          functionDeclaration: nativeLoginFillFunctionDeclaration,
          objectId,
          returnByValue: true,
        },
        control.sessionId
      )
    );
    return response.result.value;
  } finally {
    await connection
      .send("Runtime.releaseObject", { objectId }, control.sessionId)
      .catch(() => undefined);
  }
}

export function buildNativeAutofillPayload(
  kind: "address" | "payment",
  claims: readonly Pick<AutofillClaim, "token" | "value">[]
) {
  const values = new Map(claims.map(({ token, value }) => [token, value]));

  if (kind === "payment") {
    return {
      card: {
        cvc: requiredClaim(values, "cc-csc"),
        expiryMonth: requiredClaim(values, "cc-exp-month"),
        expiryYear: requiredClaim(values, "cc-exp-year"),
        name: requiredClaim(values, "cc-name"),
        number: requiredClaim(values, "cc-number"),
      },
    };
  }

  const fields = Object.entries(addressTokenToChromiumField).flatMap(
    ([token, name]) => {
      const value = values.get(token);
      return value ? [{ name, value }] : [];
    }
  );
  if (fields.length === 0) {
    throw new Error("The saved address is incomplete or invalid.");
  }
  return { address: { fields } };
}

async function inspectControls(
  connection: CdpConnection,
  sessionIds: readonly string[],
  kind: "address" | "payment"
) {
  const controls = (
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await connection.send("Page.enable", undefined, sessionId);
          const { frameTree } = frameTreeSchema.parse(
            await connection.send("Page.getFrameTree", undefined, sessionId)
          );
          return (
            await Promise.all(
              flattenFrames(frameTree).map(({ id: frameId }) =>
                inspectFrameControls(
                  connection,
                  sessionId,
                  frameId,
                  kind
                ).catch(() => [])
              )
            )
          ).flat();
        } catch {
          return [];
        }
      })
    )
  ).flat();

  return controls.toSorted((left, right) => {
    if (left.focused !== right.focused) return left.focused ? -1 : 1;
    if (left.standard !== right.standard) return left.standard ? -1 : 1;
    return left.order - right.order;
  });
}

async function inspectFrameControls(
  connection: CdpConnection,
  sessionId: string,
  frameId: string,
  kind: "address" | "payment"
) {
  const { executionContextId } = isolatedWorldSchema.parse(
    await connection.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "open-instinct-autofill" },
      sessionId
    )
  );
  const response = evaluatedValueSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: executionContextId,
        expression: controlInspectionExpression,
        returnByValue: true,
      },
      sessionId
    )
  );
  const descriptors = controlDescriptorsSchema.parse(response.result.value);

  return (
    await Promise.all(
      descriptors.map(async (descriptor, order) => {
        const evaluated = evaluatedObjectSchema.parse(
          await connection.send(
            "Runtime.evaluate",
            {
              contextId: executionContextId,
              expression: `document.querySelectorAll("input, select, textarea").item(${String(descriptor.index)})`,
            },
            sessionId
          )
        );
        const objectId = evaluated.result.objectId;
        if (!objectId) return null;

        try {
          const described = describedNodeSchema.parse(
            await connection.send("DOM.describeNode", { objectId }, sessionId)
          );
          return {
            backendNodeId: described.node.backendNodeId,
            focused: descriptor.focused,
            frameId,
            order,
            sessionId,
            standard: standardAutocomplete(kind, descriptor.autocomplete),
          };
        } finally {
          await connection
            .send("Runtime.releaseObject", { objectId }, sessionId)
            .catch(() => undefined);
        }
      })
    )
  ).filter((control) => control !== null);
}

const controlInspectionExpression = `(() => {
  const elements = Array.from(document.querySelectorAll("input, select, textarea"));
  return elements.flatMap((element, index) => {
    if (element.disabled || ("readOnly" in element && element.readOnly)) return [];
    if (element instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio"].includes(element.type)) return [];
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return [];
    return [{ autocomplete: element.autocomplete || "", focused: document.activeElement === element, index }];
  });
})()`;

async function withKernelPage<T>(
  browserSessionId: string,
  signal: AbortSignal | undefined,
  operation: (page: {
    readonly connection: CdpConnection;
    readonly origin: string;
    readonly sessionId: readonly string[];
  }) => Promise<T>
) {
  return withRemotePage(browserSessionId, signal, async ({ page }) => {
    if (!isWebUrl(page.url()))
      throw new Error("No active browser tab was found.");
    const connection = new CdpConnection(
      await page.context().newCDPSession(page)
    );
    try {
      return await operation({
        connection,
        origin: new URL(page.url()).origin,
        sessionId: ["page"],
      });
    } finally {
      await connection.close().catch(() => undefined);
    }
  });
}

class CdpConnection {
  constructor(private readonly session: CDPSession) {}

  send(method: string, params?: object, _sessionId?: string) {
    /* oxlint-disable typescript/no-unsafe-type-assertion -- CDP command names are intentionally dynamic. */
    return Promise.resolve(this.session.send(method as never, params as never));
    /* oxlint-enable typescript/no-unsafe-type-assertion */
  }

  close() {
    return this.session.detach();
  }
}

function flattenFrames(
  node: z.infer<typeof frameTreeNodeSchema>
): { readonly id: string; readonly url: string }[] {
  return [
    node.frame,
    ...(node.childFrames ?? []).flatMap((child) => flattenFrames(child)),
  ];
}

function standardAutocomplete(
  kind: "address" | "payment",
  autocomplete: string
) {
  const token = autocomplete
    .toLowerCase()
    .split(/\s+/u)
    .findLast((value) => Boolean(value));
  if (!token) return false;
  return kind === "payment"
    ? token.startsWith("cc-")
    : [
        "name",
        "street-address",
        "address-line1",
        "address-line2",
        "address-line3",
        "address-level1",
        "address-level2",
        "postal-code",
        "country",
        "country-name",
      ].includes(token);
}

function requiredClaim(values: ReadonlyMap<string, string>, token: string) {
  const value = values.get(token);
  if (!value)
    throw new Error("The saved payment card is incomplete or invalid.");
  return value;
}

function isWebUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
