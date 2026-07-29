import type {
  SandboxAgent,
  SandboxProject,
} from "../sandbox/types/index";

export function formatProjectLine(project: SandboxProject): string {
  const source = project.gitRepo
    ? `${project.gitOwner ?? "_"}/${project.gitRepo}`
    : project.internalRepoPath ??
      project.templateRepoUrl ??
      project.normalizedSourceIdentity;
  return [
    project.id,
    project.status,
    project.sourceType,
    project.name,
    source,
  ].join("  ");
}

export function formatAgentLine(agent: SandboxAgent): string {
  const entrypoint = agent.selectedEntrypoint.name
    ? `${agent.selectedEntrypoint.scope}:${agent.selectedEntrypoint.name}`
    : agent.selectedEntrypoint.scope;
  const agentSource = agent.runtimeSource
    ? [
        agent.runtimeSource.mode,
        agent.runtimeSource.publishedSnapshotName ??
          agent.runtimeSource.publishedSnapshotId ??
          agent.runtimeSource.sourceRef,
      ]
        .filter((value): value is string => Boolean(value))
        .join(":")
    : "latest_source";
  return [
    agent.id,
    agent.status,
    agent.triggerType,
    agent.defaultWorkflowMode,
    agentSource,
    entrypoint,
    agent.name,
  ].join("  ");
}
