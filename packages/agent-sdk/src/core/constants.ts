import path from "node:path";

export const ARTIFACT_DIR = ".openpond";
export const TRACE_SUBDIR = "traces";
export const TRACE_DIR = path.join(ARTIFACT_DIR, TRACE_SUBDIR);
export const DEFAULT_AGENT_CONFIG = path.join("agent", "agent.ts");
export const OPENPOND_MANIFEST = "openpond.yaml";
export const SDK_SCHEMA_VERSION = 1;

export const ARTIFACT_SCHEMAS = {
  action: "openpond.agent.action.v1",
  actionRegistry: "openpond.agent.action-registry.v1",
  agent: "openpond.agent.local-agent.v1",
  artifactIndex: "openpond.agent.artifact-index.v1",
  agentManifest: "openpond.agent.manifest.v1",
  channel: "openpond.agent.channel.v1",
  editablePolicy: "openpond.agent.editable-policy.v1",
  envSecret: "openpond.agent.env-secret.v1",
  eval: "openpond.agent.eval.v1",
  evalResults: "openpond.agent.eval-results.v1",
  inspect: "openpond.agent.inspect.v1",
  instructions: "openpond.agent.instructions.v1",
  integration: "openpond.agent.integration.v1",
  intentRouter: "openpond.agent.intent-router.v1",
  mcpClientConnection: "openpond.agent.mcp-client-connection.v1",
  remoteAgent: "openpond.agent.remote-agent.v1",
  runtimeManifest: "openpond.runtime.manifest.v1",
  runtimeBridge: "openpond.agent.runtime-bridge.v1",
  schedule: "openpond.agent.schedule.v1",
  skill: "openpond.agent.skill.v1",
  tool: "openpond.agent.tool.v1",
  trace: "openpond.agent.trace.v1",
  validatorReport: "openpond.agent.validation.v1",
  volume: "openpond.agent.volume.v1",
  workflow: "openpond.agent.workflow.v1",
} as const;

export function traceDir(artifactDir = ARTIFACT_DIR) {
  return path.join(artifactDir, TRACE_SUBDIR);
}
