import { z } from "zod";

const successStatuses = new Set([
  "complete",
  "completed",
  "ok",
  "succeeded",
  "success",
]);

export function normalizeTaskStatus(status: string): "failure" | "success" {
  return successStatuses.has(status.trim().toLowerCase())
    ? "success"
    : "failure";
}

/**
 * Worker completion contract. Keep this lenient: Eve validates `final_output`
 * against the JSON Schema of this object, and a strict enum or
 * `additionalProperties: false` is what turned a finished browser run into a
 * formatting error the coordinator then retried.
 */
export const taskCompletionSchema = z
  .object({
    message: z.string().trim().min(1),
    status: z.string().trim().min(1),
  })
  .loose();

export interface TaskCompletion {
  message: string;
  status: "failure" | "success";
}

export function parseTaskCompletion(
  output: unknown
): TaskCompletion | undefined {
  const direct = taskCompletionSchema.safeParse(output);
  if (direct.success) {
    return {
      message: direct.data.message,
      status: normalizeTaskStatus(direct.data.status),
    };
  }
  if (typeof output !== "string") return undefined;

  try {
    const parsed = taskCompletionSchema.safeParse(JSON.parse(output));
    if (!parsed.success) return undefined;
    return {
      message: parsed.data.message,
      status: normalizeTaskStatus(parsed.data.status),
    };
  } catch {
    return undefined;
  }
}

/**
 * Runner pause reasons. Coordinator tools return `{ pause }` from this enum;
 * candidate-facing `Needs …:` copy is generated from it rather than parsed.
 */
const applicationPauseReasons = [
  "approval",
  "email_otp",
  "user_input",
  "vault_setup",
  "posting_unavailable",
] as const;

export type ApplicationPauseReason = (typeof applicationPauseReasons)[number];

const pauseCopy = {
  approval: {
    blocker: "submissionApproval",
    prefix: "Needs submission approval:",
  },
  email_otp: { blocker: "emailOtp", prefix: "Needs email OTP:" },
  posting_unavailable: {
    blocker: "postingUnavailable",
    prefix: "Needs posting unavailable:",
  },
  user_input: { blocker: "userInput", prefix: "Needs user input:" },
  vault_setup: { blocker: "vaultSetup", prefix: "Needs vault setup:" },
} as const satisfies Record<
  ApplicationPauseReason,
  { blocker: string; prefix: string }
>;

/**
 * Duplicate-dispatch status. The worker-facing error still starts with
 * `Needs existing worker:` so leftover worker instructions keep matching.
 */
export const alreadyInProgressStatus = "already_in_progress";

const extraBlockers = {
  alreadyInProgress: "already_in_progress:",
  existingWorker: "Needs existing worker:",
} as const;

type WorkerBlocker =
  | (typeof pauseCopy)[ApplicationPauseReason]["blocker"]
  | keyof typeof extraBlockers;

const workerBlockers: readonly (readonly [WorkerBlocker, string])[] = [
  ...applicationPauseReasons.map(
    (reason) =>
      [
        pauseCopy[reason].blocker,
        pauseCopy[reason].prefix,
      ] as const satisfies readonly [WorkerBlocker, string]
  ),
  ["alreadyInProgress", extraBlockers.alreadyInProgress],
  ["existingWorker", extraBlockers.existingWorker],
];

/** The exact prefix generated for a pause reason or leftover worker blocker. */
export function workerBlockerPrefix(kind: WorkerBlocker) {
  const entry = workerBlockers.find(([name]) => name === kind);
  if (!entry) throw new Error(`Unknown worker blocker: ${kind}`);
  return entry[1];
}

export function applicationPausePrefix(reason: ApplicationPauseReason) {
  return pauseCopy[reason].prefix;
}

/** Candidate-facing copy generated from the pause enum, never parsed back. */
export function applicationPauseMessage(
  reason: ApplicationPauseReason,
  detail = ""
) {
  const extra = detail.trim();
  return extra
    ? `${applicationPausePrefix(reason)} ${extra}`
    : applicationPausePrefix(reason);
}

const pauseReasonNames: ReadonlySet<string> = new Set(applicationPauseReasons);

function isApplicationPauseReason(
  value: string
): value is ApplicationPauseReason {
  return pauseReasonNames.has(value);
}

export function pauseKindFromOutput(output: {
  message?: string;
  pause?: string;
}): ApplicationPauseReason | undefined {
  if (output.pause !== undefined && isApplicationPauseReason(output.pause)) {
    return output.pause;
  }
  const blocker = output.message ? blockerKind(output.message) : undefined;
  return applicationPauseReasons.find(
    (reason) => pauseCopy[reason].blocker === blocker
  );
}

/** The blocker the worker actually reported, or undefined for anything else. */
export function blockerKind(message: string): WorkerBlocker | undefined {
  const trimmed = message.trimStart().toLowerCase();
  return workerBlockers.find(([, prefix]) =>
    trimmed.startsWith(prefix.toLowerCase())
  )?.[0];
}
