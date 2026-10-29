/** Development-only fixtures sealed by the authoritative Harness implementation. */
import { writeFile } from "node:fs/promises";
import { contentHash } from "../../../packages/harness/src/common.ts";
import {
  ToolLearningInstallationSchema,
  ToolLearningConsultationRequestSchema,
} from "../../../packages/evals/src/tool-learning/index.ts";

const ref = { id: "fixture-release", contentHash: "a".repeat(64) };
const policy = {
  revision: 1,
  permittedTools: ["exec_command"],
  workspaceRootHashes: ["b".repeat(64)],
  permittedFields: ["action", "intent", "state", "result_excerpt"],
  unchangedControls: { numerator: 0, denominator: 1 },
  maximumEventBytes: 65536,
  maximumEpisodeBytes: 2097152,
  maximumEpisodeEvents: 256,
  maximumQueueBytes: 52428800,
  maximumQueueEvents: 5000,
  maximumQueueAgeSeconds: 86400,
  rawRetentionDays: 1,
  purposes: ["capture", "consultation"],
  modelUpdates: "requires_separate_review",
  variantGeneration: "disabled",
};
const installation = ToolLearningInstallationSchema.parse({
  schemaVersion: "openpond.toolLearningInstallation.v1",
  id: "installation-fixture",
  revision: 1,
  scope: { teamId: "team-fixture", projectId: "project-fixture" },
  ownerUserId: "user-fixture",
  machineSourceId: "source-fixture",
  client: "openpond",
  clientVersion: "fixture-v1",
  adapterRelease: ref,
  state: "enabled",
  collectionPolicy: policy,
  collectionPolicyHash: contentHash(policy),
  coverage: {
    receipt: null,
    start: "unqualified",
    resume: "unqualified",
    compaction: "unqualified",
    executionFailure: "unqualified",
    processFailure: "unqualified",
    validationFailure: "unqualified",
    nestedCalls: "unqualified",
    contextRefresh: "unqualified",
    gaps: ["Fixture only; no client qualification"],
  },
  credential: {
    id: "credential-fixture",
    expiresAt: "2099-01-01T00:00:00Z",
    revokedAt: null,
    capabilities: ["episode_append", "manifest_read", "consultation_submit", "consultation_read"],
  },
  createdAt: "2026-10-29T00:00:00Z",
  updatedAt: "2026-10-29T00:00:00Z",
});
const action = { kind: "shell", shell: "bash", command: "python -c 'print(1)'" };
const environment = {
  application: "fixture",
  version: "v1",
  state: { cwd: "fixture" },
  fingerprint: "c".repeat(64),
};
const failure = {
  message: "A retained fixture error",
  observation: { id: "observation-fixture", contentHash: "d".repeat(64) },
};
const intent = "Print one.";
const request = ToolLearningConsultationRequestSchema.parse({
  schemaVersion: "openpond.toolLearningConsultation.v1",
  operationId: "consultation-fixture",
  installationId: installation.id,
  scope: installation.scope,
  sessionId: "session-fixture",
  callId: "call-fixture",
  capabilityId: "capability-fixture",
  manifestHash: "e".repeat(64),
  modelRelease: ref,
  mode: "recovery",
  intent,
  action,
  actionHash: contentHash(action),
  environment,
  contextHash: contentHash({ intent, environment, failure }),
  failure,
  round: 1,
});
const response = {
  schemaVersion: "openpond.toolLearningDecision.v1",
  operationId: request.operationId,
  installationId: request.installationId,
  capabilityId: request.capabilityId,
  manifestHash: request.manifestHash,
  modelRelease: request.modelRelease,
  actionHash: request.actionHash,
  contextHash: request.contextHash,
  state: "completed",
  decision: { decision: "needs_context", missing: [{ field: "error", reason: "Fixture only" }] },
  usageReceipt: { id: "usage-fixture", contentHash: "f".repeat(64) },
  completedAt: "2026-10-29T00:00:00Z",
};
await writeFile(
  new URL("../src/ponder_sdk/fixtures/tool-learning.valid.json", import.meta.url),
  JSON.stringify({ installation, request, response }, null, 2) + "\n",
);
