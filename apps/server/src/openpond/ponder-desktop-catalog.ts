import { createHash } from "node:crypto";
import {
  PonderDesktopCatalogSchema,
  PONDER_DESKTOP_CATALOG_MAX_TARGETS,
  PonderDesktopTargetSchema,
  ponderDesktopRequestContent,
  type LocalManagedMessageTarget,
  type PonderDesktopTarget,
  type Session,
  type OpenPondProfileRef,
} from "@openpond/contracts";
import { ponderOwnsLocalSession, type PonderLocalOwner } from "./ponder-local-scope.js";

function hash(value: unknown) {
  return createHash("sha256")
    .update(ponderDesktopRequestContent("POST", "/ponder/desktop/catalog", value))
    .digest("hex");
}

export function ponderDesktopProfileSelectionId(profile: OpenPondProfileRef | null | undefined) {
  return profile ? hash(profile) : null;
}

import { localSessionOwnershipRevision as ponderDesktopSessionRevision } from "../remote-relay/session-ownership.js";
export { ponderDesktopSessionRevision };

/** Queueing may outlive another turn; its selected configuration must remain the same. */
export function ponderDesktopExecutionRevision(session: Session) {
  return hash({
    provider: session.provider,
    modelRef: session.modelRef ?? null,
    experience: session.experience,
    profile: session.currentProfile ?? null,
    workflow: session.profileWorkflowBinding ?? null,
    component: session.profileComponentBinding ?? null,
    cwd: session.cwd,
    workspaceKind: session.workspaceKind ?? null,
    workspaceId: session.workspaceId ?? null,
    localProjectId: session.localProjectId ?? null,
    cloudProjectId: session.cloudProjectId ?? null,
    owner: session.metadata?.ponderLocalOwner ?? null,
    projectRevision: session.metadata?.ponderWorkspaceRevision ?? null,
    commandAccessMode: session.openPondCommandAccessMode,
  });
}

/** Includes only sessions with protected, exact login ownership. Unknown/imported history stays local. */
export async function capturePonderDesktopCatalog(input: {
  owner: PonderLocalOwner;
  sessions: Session[];
  inspect(sessionId: string): Promise<LocalManagedMessageTarget>;
  starters: PonderDesktopTarget[];
}) {
  const targets: PonderDesktopTarget[] = [];
  for (const session of input.sessions) {
    if (
      !ponderOwnsLocalSession(session, input.owner) ||
      session.archived ||
      session.systemKind ||
      session.experience === "development" ||
      session.hiddenFromDefaultSidebar ||
      session.status === "closed" ||
      ["sandbox", "sandbox_template", "sandbox_app"].includes(session.workspaceKind ?? "")
    )
      continue;
    const managed = await input.inspect(session.id);
    const workspaceId = session.localProjectId ?? session.workspaceId ?? session.cwd;
    if (!workspaceId) continue;
    const profileSelectionId = ponderDesktopProfileSelectionId(session.currentProfile);
    if (targets.length >= PONDER_DESKTOP_CATALOG_MAX_TARGETS)
      throw new Error("ponder_desktop_catalog_resource_limit_exceeded");
    targets.push(
      PonderDesktopTargetSchema.parse({
        id: session.id,
        kind: "session",
        title: session.title || "Local task",
        providerId: session.provider,
        modelId: session.modelRef?.modelId ?? null,
        experience: session.experience,
        workspaceId,
        workspaceLabel: session.workspaceName ?? session.cwd ?? workspaceId,
        profileSelectionId,
        revision: ponderDesktopSessionRevision(session, managed.latestTurnId),
        available: managed.canSendFollowup,
        unavailableReason: managed.unavailableReason,
        canMessage: managed.canSendFollowup,
        canSteer: managed.canSteer,
        canStop: managed.activeTurnId !== null && managed.managedSessionId !== null,
        activeTurnId: managed.activeTurnId,
      }),
    );
  }
  for (const starter of input.starters) {
    const target = PonderDesktopTargetSchema.parse(starter);
    if (target.kind !== "starter") throw new Error("ponder_desktop_starter_kind_invalid");
    if (targets.length >= PONDER_DESKTOP_CATALOG_MAX_TARGETS)
      throw new Error("ponder_desktop_catalog_resource_limit_exceeded");
    targets.push(target);
  }
  targets.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(targets.map((target) => target.id)).size !== targets.length)
    throw new Error("ponder_desktop_catalog_duplicate_target");
  return PonderDesktopCatalogSchema.parse({
    targets,
    capturedAt: new Date().toISOString(),
    revision: hash(targets),
  });
}
