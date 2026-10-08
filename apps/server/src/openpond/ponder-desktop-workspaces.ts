import { createHash } from "node:crypto";
import {
  ponderDesktopRequestContent,
  type Session,
  type OpenPondCommandAccessMode,
} from "@openpond/contracts";
import type {
  PonderProjectSharing,
  PonderProjectSharingAuthority,
} from "../store/ponder-project-sharing.js";
import { projectSharingMatchesAuthority } from "../store/ponder-project-sharing.js";
import type { PonderProjectSnapshot } from "./ponder-project-snapshot.js";

export type PonderDesktopWorkspace = Pick<
  Session,
  | "experience"
  | "cwd"
  | "workspaceKind"
  | "workspaceId"
  | "workspaceName"
  | "localProjectId"
  | "currentProfile"
  | "profileWorkflowBinding"
  | "profileComponentBinding"
  | "openPondCommandAccessMode"
> & { projectRevision?: string };

/** Only the current, explicit grant and the current filesystem snapshot can make a fresh workspace. */
export function ponderSharedProjectWorkspaces(input: {
  grants: PonderProjectSharing[];
  authority: PonderProjectSharingAuthority;
  snapshots: Map<string, PonderProjectSnapshot>;
  commandAccessMode: OpenPondCommandAccessMode;
}) {
  const blockedProjects = new Set<string>();
  const workspaces: PonderDesktopWorkspace[] = [];
  for (const grant of input.grants) {
    const snapshot = input.snapshots.get(grant.project.projectId);
    if (
      !projectSharingMatchesAuthority(grant, input.authority) ||
      snapshot?.revision !== grant.project.revision
    ) {
      blockedProjects.add(grant.project.projectId);
      continue;
    }
    for (const experience of ["chat", "work"] as const)
      workspaces.push({
        experience,
        cwd: snapshot.cwd,
        workspaceKind: "local_project",
        workspaceId: snapshot.projectId,
        workspaceName: snapshot.name,
        localProjectId: snapshot.projectId,
        currentProfile: null,
        openPondCommandAccessMode: input.commandAccessMode,
        projectRevision: createHash("sha256")
          .update(
            ponderDesktopRequestContent("POST", "/local/ponder-project-grant", {
              projectRevision: snapshot.revision,
              sharingRevision: grant.revision,
              authority: grant.authority,
            }),
          )
          .digest("hex"),
      });
  }
  return { workspaces, blockedProjects };
}
