import path from "node:path";

import {
  collectAgentSdkProjectSourceUploadEntries,
  collectProjectSourceUploadEntries,
  mergeProjectSourceUploadEntries,
} from "./project-source-upload.js";
import {
  loadOpenPondProfileState,
  type LocalOpenPondProfilePushStatus,
} from "./local-profile.js";
import type { OpenPondSandboxClient } from "../sandbox/client.js";

type LoadedOpenPondProfileState = Awaited<
  ReturnType<typeof loadOpenPondProfileState>
>;

export async function materializeHostedProfileAgentSource(input: {
  client: OpenPondSandboxClient;
  teamId: string;
  profileProjectId: string;
  profileName: string;
  state: LoadedOpenPondProfileState;
  agentId: string;
  sourceRef: string;
  localHead: string | null;
  hostedHead: string | null;
  projectId?: string | null;
}): Promise<
  NonNullable<
    LocalOpenPondProfilePushStatus["hostedSourceMaterialization"]
  >
> {
  if (!input.state.sourcePath) {
    throw new Error("Active OpenPond profile is missing a source path.");
  }
  const agent = input.state.agents.find(
    (candidate) => candidate.id === input.agentId,
  );
  if (!agent) {
    throw new Error(
      `Profile agent not found for hosted materialization: ${input.agentId}`,
    );
  }
  if (!agent.enabled) {
    throw new Error(`Profile agent is disabled: ${input.agentId}`);
  }

  const sourceRoot = resolveProfileAgentSourceRoot(
    input.state.sourcePath,
    agent.path,
  );
  const collected = await collectProjectSourceUploadEntries(sourceRoot);
  const agentSdk = await collectAgentSdkProjectSourceUploadEntries(
    sourceRoot,
    collected.entries,
  );
  const upload = mergeProjectSourceUploadEntries(
    collected,
    agentSdk.entries,
  );

  const materializationProject = await getOrCreateHostedSourceProject({
    client: input.client,
    teamId: input.teamId,
    projectId: input.projectId ?? null,
    profileProjectId: input.profileProjectId,
    profileName: input.profileName,
    agentId: input.agentId,
    localHead: input.localHead,
    hostedHead: input.hostedHead,
  });
  const uploadedProject = await input.client.projects.uploadSource(
    materializationProject.id,
    {
      teamId: input.teamId,
      entries: upload.entries,
      branch: input.sourceRef,
      commitMessage: `Materialize OpenPond profile agent ${input.agentId}`,
    },
  );
  const syncedProject = await input.client.projects.sync(uploadedProject.id, {
    teamId: input.teamId,
  });
  const sourceCommitSha =
    sandboxProjectSourceCommitSha(syncedProject) ??
    sandboxProjectSourceCommitSha(uploadedProject);
  const sourceRef =
    sandboxProjectSourceRef(syncedProject) ??
    sandboxProjectSourceRef(uploadedProject) ??
    input.sourceRef;
  const runtimeAgent = await input.client.agents.upsert({
    teamId: input.teamId,
    projectId: syncedProject.id,
    name: agent.name || input.agentId,
    slug: hostedRuntimeAgentSlug(input.profileName, input.agentId),
    selectedEntrypoint: hostedEntrypointForProfileAgent(
      input.state,
      input.agentId,
    ),
    triggerType: "manual",
    runtimeSource: {
      mode: "latest_source",
      ...(sourceRef ? { sourceRef } : {}),
      ...(sourceCommitSha ? { sourceCommitSha } : {}),
    },
    metadata: {
      source: "openpond_profile_agent_materialization",
      profileProjectId: input.profileProjectId,
      profileName: input.profileName,
      profileAgentId: input.agentId,
      profileSourcePath: agent.path,
      localHead: input.localHead,
      hostedHead: input.hostedHead,
    },
    externalId: `openpond-profile-agent:${input.profileProjectId}:${input.profileName}:${input.agentId}`,
  });

  const uploadMetadata = record(agentSdk.uploadMetadata);
  const commands = record(uploadMetadata?.commands);
  const dependencySetup = record(uploadMetadata?.dependencySetup);
  const setupCommands = stringArray(dependencySetup?.commands);
  const validationCommands = [
    text(commands?.validate),
    text(commands?.eval),
  ].filter((command): command is string => Boolean(command));

  return {
    status: "uploaded",
    agentId: input.agentId,
    runtimeAgentId: runtimeAgent.id,
    projectId: syncedProject.id,
    sourceRoot,
    sourceRef,
    sourceCommitSha: sourceCommitSha ?? null,
    manifestHash: syncedProject.sandboxManifestHash ?? null,
    manifestPath: syncedProject.sandboxManifestPath ?? null,
    manifestSyncedAt: syncedProject.sandboxManifestSyncedAt ?? null,
    fileCount: upload.fileCount,
    totalBytes: upload.totalBytes,
    generatedManifestPath: agentSdk.generatedManifestPath,
    synthesizedOpenPondYaml: agentSdk.synthesizedOpenPondYaml,
    uploadMetadataPath: agentSdk.uploadMetadataPath,
    setupCommands,
    validationCommands,
    materializedAt: new Date().toISOString(),
  };
}

async function getOrCreateHostedSourceProject(input: {
  client: OpenPondSandboxClient;
  teamId: string;
  projectId: string | null;
  profileProjectId: string;
  profileName: string;
  agentId: string;
  localHead: string | null;
  hostedHead: string | null;
}) {
  if (input.projectId) {
    try {
      return await input.client.projects.get(input.projectId, {
        teamId: input.teamId,
      });
    } catch {
      // Recreate a materialization project that was removed remotely.
    }
  }
  return input.client.projects.upsert({
    teamId: input.teamId,
    name: `OpenPond profile ${input.profileName} ${input.agentId}`,
    sourceType: "manual",
    externalId: `openpond-profile:${input.profileProjectId}:${input.profileName}:${input.agentId}`,
    description: `Materialized OpenPond profile agent ${input.agentId} for hosted Team execution.`,
    metadata: {
      source: "openpond_profile_agent_materialization",
      profileProjectId: input.profileProjectId,
      profileName: input.profileName,
      profileAgentId: input.agentId,
      localHead: input.localHead,
      hostedHead: input.hostedHead,
    },
  });
}

function resolveProfileAgentSourceRoot(
  sourcePath: string,
  agentPath: string,
): string {
  const normalized = agentPath.replace(/\\/g, "/");
  const absolute = path.resolve(sourcePath, normalized);
  const relative = path.relative(sourcePath, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Profile agent path escapes profile source: ${agentPath}`);
  }
  return normalized === "agent/agent.ts" || normalized.endsWith("/agent.ts")
    ? sourcePath
    : absolute;
}

function hostedEntrypointForProfileAgent(
  state: LoadedOpenPondProfileState,
  agentId: string,
) {
  const action =
    state.actionCatalog.find(
      (candidate) =>
        candidate.agentId === agentId &&
        (candidate.sourceActionId === "chat" || candidate.name === "chat"),
    ) ??
    state.actionCatalog.find((candidate) => candidate.agentId === agentId);
  return {
    scope: "action" as const,
    name:
      (typeof action?.sourceActionId === "string" &&
        action.sourceActionId) ||
      (typeof action?.name === "string" && action.name) ||
      "chat",
  };
}

function hostedRuntimeAgentSlug(
  profileName: string,
  agentId: string,
): string {
  const slug = `openpond-profile-${profileName}-${agentId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "openpond-profile-agent";
}

function sandboxProjectSourceCommitSha(project: unknown): string | null {
  const item = record(project);
  const sourceConfig = record(item?.sourceConfig);
  const metadata = record(item?.metadata);
  return (
    text(sourceConfig?.sourceCommitSha) ??
    text(sourceConfig?.commitSha) ??
    text(sourceConfig?.remoteSha) ??
    text(metadata?.projectSourceUploadCommitSha) ??
    text(metadata?.sourceCommitSha) ??
    text(item?.templateRemoteSha)
  );
}

function sandboxProjectSourceRef(project: unknown): string | null {
  const item = record(project);
  const sourceConfig = record(item?.sourceConfig);
  return (
    text(sourceConfig?.sourceRef) ??
    text(sourceConfig?.branch) ??
    text(item?.gitBranch) ??
    text(item?.defaultBranch)
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
