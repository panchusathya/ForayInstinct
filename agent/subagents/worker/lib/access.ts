import type { SessionContext } from "eve/context";
import { assertNoConcurrentApplicationWorker } from "@/db/services/application-executions";
import { assertApplicationLeaseOwner } from "@/db/services/application-leases";
import { ensureScope } from "@/db/services/scope";
import { claimSession, isSessionOwned } from "@/db/services/sessions";
import { scopeFromPrincipal } from "@/lib/access-scope";

export async function requireWorkerScope(
  context: Pick<SessionContext, "session">
) {
  const parent = context.session.parent;
  if (!parent) throw new Error("Browser tools require a delegated worker.");

  const { current, initiator } = context.session.auth;
  const owner = initiator ?? current;
  if (!owner) throw new Error("An authenticated user is required.");
  if (
    current?.principalType === "user" &&
    initiator?.principalType === "user" &&
    current.principalId !== initiator.principalId
  ) {
    throw new Error("A different user cannot continue this browser task.");
  }

  // A local delegated worker can begin before Eve's session-start hook has
  // observed the forwarded principal. The root session is the authority: once
  // it is owned by this caller, claim the child lazily instead of turning that
  // harmless ordering race into an application failure.
  const scope = scopeFromPrincipal(owner);
  let [ownsWorker, ownsParent] = await Promise.all([
    isSessionOwned(scope, context.session.id),
    isSessionOwned(scope, parent.rootSessionId),
  ]);
  if (!ownsParent) {
    await ensureScope(scope);
    await claimSession(scope, parent.rootSessionId);
    ownsParent = await isSessionOwned(scope, parent.rootSessionId);
  }
  if (!ownsParent) {
    throw new Error("The authenticated user does not own this worker session.");
  }
  if (!ownsWorker) {
    await ensureScope(scope);
    await claimSession(scope, context.session.id);
    ownsWorker = await isSessionOwned(scope, context.session.id);
  }
  if (!ownsWorker) {
    throw new Error("The authenticated user does not own this worker session.");
  }
  await assertApplicationLeaseOwner({
    parentCallId: parent.callId,
    rootSessionId: parent.rootSessionId,
    workerSessionId: context.session.id,
  });
  await assertNoConcurrentApplicationWorker({
    parentCallId: parent.callId,
    rootSessionId: parent.rootSessionId,
    workerSessionId: context.session.id,
  });
  return scope;
}
