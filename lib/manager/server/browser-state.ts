import {
  storageStateSchema,
  type GatewayStorageState,
} from "@/lib/browser/contract";
import { sanitizeStorageState } from "@/lib/browser/storage-state";
import {
  deleteSecret,
  readSecret,
  writeSecret,
} from "@/lib/manager/server/secret-store";
import { ensureScope } from "@/db/services/scope";
import type { AccessScope } from "@/lib/access-scope";

const storageStateSecretId = "storage-state";

/**
 * Per-workspace signed-in browser state for the gateway provider: the
 * Playwright storage state exported when a session closes, restored into the
 * next created session. Cookies are live ATS credentials, so the blob is
 * encrypted through the workspace secret store rather than stored plain.
 */
export async function readWorkspaceBrowserState(
  scope: AccessScope
): Promise<GatewayStorageState | undefined> {
  await ensureScope(scope);
  const raw = await readSecret({
    id: storageStateSecretId,
    namespace: "browser-state",
    scope,
  });
  if (raw === undefined) return undefined;
  try {
    // What a browser will refuse is known before it is asked; a stale or
    // malformed cookie in this blob otherwise fails every session it seeds.
    return sanitizeStorageState(storageStateSchema.parse(JSON.parse(raw)));
  } catch {
    // A malformed blob must not block creating a browser; drop it.
    await clearWorkspaceBrowserState(scope).catch(() => undefined);
    return undefined;
  }
}

export async function saveWorkspaceBrowserState(
  scope: AccessScope,
  storageState: GatewayStorageState
) {
  await ensureScope(scope);
  await writeSecret({
    id: storageStateSecretId,
    namespace: "browser-state",
    scope,
    value: JSON.stringify(storageState),
  });
}

/** Kill switch behind the "Sign out everywhere" button. */
export async function clearWorkspaceBrowserState(scope: AccessScope) {
  await ensureScope(scope);
  await deleteSecret({
    id: storageStateSecretId,
    namespace: "browser-state",
    scope,
  });
}

export async function hasWorkspaceBrowserState(scope: AccessScope) {
  await ensureScope(scope);
  return (
    (await readSecret({
      id: storageStateSecretId,
      namespace: "browser-state",
      scope,
    })) !== undefined
  );
}
