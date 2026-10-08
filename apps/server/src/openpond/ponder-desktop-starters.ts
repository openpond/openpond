import type { PonderDesktopWorkspace } from "./ponder-desktop-workspaces.js";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  CreateSessionRequestSchema,
  PONDER_DESKTOP_CATALOG_MAX_TARGETS,
  PonderDesktopTargetSchema,
  ponderDesktopRequestContent,
  type ProviderSettings,
  type OpenPondProfileRef,
  type OpenPondProfileCatalogEntry,
  type PonderDesktopTarget,
  type Session,
} from "@openpond/contracts";
import { ponderDesktopProfileSelectionId } from "./ponder-desktop-catalog.js";
import { ponderOwnsLocalSession, type PonderLocalOwner } from "./ponder-local-scope.js";

/** A starter is a verified local provider/workspace/Profile selection, never an imported transcript. */
export async function capturePonderDesktopStarters(input: {
  owner: PonderLocalOwner;
  sessions: Session[];
  projectWorkspaces: PonderDesktopWorkspace[];
  blockedProjects: ReadonlySet<string>;
  providers: ProviderSettings;
  profiles: Array<
    Pick<OpenPondProfileCatalogEntry, "ref" | "name" | "repoPath" | "sourcePath"> & {
      state: Pick<OpenPondProfileCatalogEntry["state"], "mode" | "error" | "setupGate">;
    }
  >;
}) {
  const profiles: Array<{ ref: OpenPondProfileRef | null; name: string }> = [
    { ref: null, name: "No Profile" },
  ];
  for (const profile of input.profiles) {
    if (
      profile.state.mode !== "local" ||
      profile.state.error ||
      profile.state.setupGate.status !== "ready" ||
      !profile.sourcePath ||
      !(await stat(profile.sourcePath).catch(() => null))?.isDirectory() ||
      !(await stat(profile.repoPath).catch(() => null))?.isDirectory()
    )
      continue;
    profiles.push({ ref: profile.ref, name: profile.name });
  }
  const starters = new Map<string, { target: PonderDesktopTarget; payload: unknown }>();
  const workspaces: PonderDesktopWorkspace[] = [...input.projectWorkspaces];
  for (const session of input.sessions) {
    if (
      !ponderOwnsLocalSession(session, input.owner) ||
      (session.localProjectId && input.blockedProjects.has(session.localProjectId)) ||
      session.archived ||
      session.systemKind ||
      session.hiddenFromDefaultSidebar ||
      session.status === "closed" ||
      session.experience === "development" ||
      ["sandbox", "sandbox_template", "sandbox_app"].includes(session.workspaceKind ?? "") ||
      session.metadata?.nativeHistoryProjection ||
      !session.cwd
    )
      continue;
    const projectWorkspace = session.localProjectId
      ? input.projectWorkspaces.find(
          (workspace) =>
            workspace.localProjectId === session.localProjectId &&
            workspace.experience === session.experience,
        )
      : null;
    workspaces.push(
      projectWorkspace
        ? {
            ...session,
            ...projectWorkspace,
            currentProfile: session.currentProfile,
            profileWorkflowBinding: session.profileWorkflowBinding,
            profileComponentBinding: session.profileComponentBinding,
          }
        : session,
    );
  }
  for (const session of workspaces) {
    if (!session.cwd || !(await stat(session.cwd).catch(() => null))?.isDirectory()) continue;
    for (const provider of Object.values(input.providers.statuses)) {
      if (
        !provider.enabled ||
        !provider.available ||
        !provider.routing.localRuntime ||
        provider.lifecycleStatus === "deprecated" ||
        !provider.capabilities.toolCalling
      )
        continue;
      const cache = input.providers.modelCaches[provider.id];
      const models = new Set([
        ...provider.modelIds,
        ...(provider.defaultModel ? [provider.defaultModel] : []),
      ]);
      const native = ["codex", "claude-code", "opencode", "grok-build"].includes(provider.id);
      // Native adapters can expose their own default without a model catalog. BYOK
      // models require current model-level agent capability, not a copied session.
      const selections: Array<string | null> = models.size
        ? [...models].sort()
        : native
          ? [null]
          : [];
      for (const modelId of selections) {
        const model = modelId
          ? cache?.models.find((model) => model.providerId === provider.id && model.id === modelId)
          : null;
        if (
          (model && (model.lifecycleStatus === "deprecated" || !model.capabilities.toolCalling)) ||
          (!native && !model)
        )
          continue;
        for (const profile of profiles) {
          const sameProfile =
            profile.ref !== null &&
            ponderDesktopProfileSelectionId(profile.ref) ===
              ponderDesktopProfileSelectionId(session.currentProfile);
          const bindings = [
            {
              label: "",
              workflow: undefined as Session["profileWorkflowBinding"],
              component: undefined as Session["profileComponentBinding"],
            },
          ];
          if (sameProfile && (session.profileWorkflowBinding || session.profileComponentBinding)) {
            const component = session.profileComponentBinding?.target;
            bindings.push({
              label: session.profileWorkflowBinding
                ? ` · workflow ${session.profileWorkflowBinding.workflowId}`
                : component?.kind === "skill"
                  ? ` · skill ${component.skillPath}`
                  : component?.kind === "agent_action"
                    ? ` · action ${component.actionId}`
                    : " · Profile evaluation",
              workflow: session.profileWorkflowBinding,
              component: session.profileComponentBinding,
            });
          }
          for (const binding of bindings) {
            const payload = JSON.parse(
              JSON.stringify(
                CreateSessionRequestSchema.parse({
                  experience: session.experience,
                  provider: provider.id,
                  modelRef: modelId ? { providerId: provider.id, modelId } : undefined,
                  openPondCommandAccessMode: session.openPondCommandAccessMode,
                  cwd: session.cwd,
                  workspaceKind: session.workspaceKind,
                  workspaceId: session.workspaceId,
                  workspaceName: session.workspaceName,
                  localProjectId: session.localProjectId,
                  currentProfile: profile.ref,
                  metadata: session.projectRevision
                    ? { ponderWorkspaceRevision: session.projectRevision }
                    : undefined,
                  profileWorkflowBinding: binding.workflow,
                  profileComponentBinding: binding.component,
                }),
              ),
            ) as Record<string, unknown>;
            const revision = createHash("sha256")
              .update(ponderDesktopRequestContent("POST", "/local/starter", payload))
              .digest("hex");
            const target = PonderDesktopTargetSchema.parse({
              id: `starter:${revision}`,
              kind: "starter",
              title:
                `${provider.displayName}${modelId ? ` · ${modelId}` : ""} · ${profile.name}${binding.label} · ${session.experience} in ${session.workspaceName ?? session.cwd}`.slice(
                  0,
                  300,
                ),
              providerId: provider.id,
              modelId,
              experience: session.experience,
              workspaceId: session.localProjectId ?? session.workspaceId ?? session.cwd,
              workspaceLabel: (session.workspaceName ?? session.cwd).slice(0, 300),
              profileSelectionId: ponderDesktopProfileSelectionId(profile.ref),
              revision,
              available: true,
              unavailableReason: null,
              canMessage: false,
              canSteer: false,
              canStop: false,
              activeTurnId: null,
            });
            if (!starters.has(target.id) && starters.size >= PONDER_DESKTOP_CATALOG_MAX_TARGETS)
              throw new Error("ponder_desktop_catalog_resource_limit_exceeded");
            starters.set(target.id, { target, payload });
          }
        }
      }
    }
  }
  return starters;
}
